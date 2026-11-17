import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { newRun, transition, validateDefinition } from '../src/core/engine.js';
import { isTerminal } from '../src/core/types.js';
import type { AutomationDefinition, Run, RunEvent, Step, TransitionResult } from '../src/core/types.js';

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.constant<Step>({ type: 'reply_to_comment', text: 'Sent you a DM!' }),
  fc.constant<Step>({ type: 'send_dm', text: 'Here you go' }),
  fc.record(
    {
      type: fc.constant('ask' as const),
      prompt: fc.constant('Your email?'),
      capture: fc.constantFrom('email' as const, 'any' as const),
      saveAs: fc.constantFrom('email', 'name'),
      timeoutSeconds: fc.integer({ min: 60, max: 3600 }),
      maxAttempts: fc.integer({ min: 1, max: 5 }),
      repromptText: fc.constant('Again?'),
      skipIfKnown: fc.boolean(),
    },
    { requiredKeys: ['type', 'prompt', 'capture', 'saveAs', 'timeoutSeconds', 'maxAttempts', 'repromptText'] },
  ),
);

const definitionArb: fc.Arbitrary<AutomationDefinition> = fc
  .array(stepArb, { minLength: 1, maxLength: 6 })
  .map((steps) => ({
    trigger: { type: 'comment_keyword' as const, platform: 'instagram' as const, keywords: ['pricing'], match: 'contains' as const, postIds: 'any' as const },
    steps,
  }))
  .filter((definition) => validateDefinition(definition).ok);

/**
 * Events are generated as intents and resolved against the current run, so
 * that sequences reach deep states (the pending key is known only at run time)
 * while still mixing in stale keys, early timers and duplicates.
 */
type Intent =
  | { type: 'start'; known: Record<string, string> }
  | { type: 'succeed_pending' }
  | { type: 'fail_pending'; code: string }
  | { type: 'stale'; key: string; fail: boolean }
  | { type: 'message'; text: string }
  | { type: 'timer'; atWakeAt: boolean }
  | { type: 'cancel' };

const intentArb: fc.Arbitrary<Intent> = fc.oneof(
  { weight: 1, arbitrary: fc.record({ type: fc.constant('start' as const), known: fc.constantFrom({}, { email: 'k@k.co' }, { name: 'Kim' }) }) },
  { weight: 6, arbitrary: fc.constant({ type: 'succeed_pending' as const }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant('fail_pending' as const), code: fc.constantFrom('blocked', 'gone') }) },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant('stale' as const),
      key: fc.oneof(fc.string(), fc.tuple(fc.nat(6), fc.nat(5)).map(([i, a]) => `r1:${i}:${a}`)),
      fail: fc.boolean(),
    }),
  },
  { weight: 4, arbitrary: fc.record({ type: fc.constant('message' as const), text: fc.oneof(fc.constantFrom('no', '', 'a@b.co', 'Ann', 'mail: x@y.org!'), fc.string()) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant('timer' as const), atWakeAt: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ type: 'cancel' as const }) },
);

const resolve = (intent: Intent, run: Run): RunEvent => {
  switch (intent.type) {
    case 'start':
      return intent;
    case 'succeed_pending':
      return { type: 'effect_succeeded', key: run.pendingEffectKey ?? 'none' };
    case 'fail_pending':
      return { type: 'effect_failed', key: run.pendingEffectKey ?? 'none', code: intent.code };
    case 'stale':
      return intent.fail ? { type: 'effect_failed', key: intent.key, code: 'x' } : { type: 'effect_succeeded', key: intent.key };
    case 'message':
      return { type: 'message_received', messageId: 'm', text: intent.text };
    case 'timer':
      return { type: 'timer_fired' };
    case 'cancel':
      return { type: 'cancel', reason: 'test' };
  }
};

const scenarioArb = fc.record({
  definition: definitionArb,
  // Start most runs so that the interesting states are reached.
  intents: fc.tuple(fc.boolean(), fc.array(intentArb, { maxLength: 30 })).map(([started, rest]): Intent[] =>
    started ? [{ type: 'start', known: {} }, ...rest] : rest,
  ),
  deltas: fc.array(fc.oneof(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: -10_000, max: 8_000_000 })), { minLength: 30, maxLength: 30 }),
});

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

type Scenario = typeof scenarioArb extends fc.Arbitrary<infer S> ? S : never;

interface Transitioned {
  before: Run;
  at: number;
  result: TransitionResult;
}

/** Plays a scenario, deep-freezing every input, and returns each transition. */
const play = ({ definition, intents, deltas }: Scenario): Transitioned[] => {
  deepFreeze(definition);
  const comment = { eventId: 'e', accountId: 'acct', commentId: 'c', postId: 'p', authorId: 'u', text: 'pricing', at: 0 };
  const version = { id: 'v', automationId: 'a', accountId: 'acct', enabled: true, cooldownSeconds: 0, definition };
  let run = newRun({ id: 'r1', version, comment, now: 0 });
  let now = 0;
  const history: Transitioned[] = [];
  intents.forEach((intent, i) => {
    now += deltas[i % deltas.length] ?? 0;
    const before = deepFreeze(run);
    const event = resolve(intent, before);
    const at = intent.type === 'timer' && intent.atWakeAt && before.wakeAt !== null ? before.wakeAt : now;
    const result = transition(definition, before, event, at);
    history.push({ before, at, result });
    run = result.run;
  });
  return history;
};

const property = (check: (history: Transitioned[]) => void) =>
  fc.assert(fc.property(scenarioArb, (scenario) => check(play(scenario))), { numRuns: 500 });

describe('transition properties', () => {
  it('never throws and never mutates its input', () => {
    // play() deep-freezes the definition and every input run, and ESM is
    // strict mode, so any write to them throws here.
    property(() => {});
  });

  it('emits an effect exactly when the run starts awaiting it', () => {
    property((history) => {
      for (const { before, result } of history) {
        const { run, effect } = result;
        if (effect !== null) {
          expect(run.status).toBe('awaiting_effect');
          expect(run.pendingEffectKey).toBe(effect.key);
        } else if (run.status === 'awaiting_effect') {
          expect(before.status).toBe('awaiting_effect');
          expect(before.pendingEffectKey).toBe(run.pendingEffectKey);
        }
      }
    });
  });

  it('treats terminal runs as absorbing', () => {
    property((history) => {
      for (const { before, result } of history) {
        if (!isTerminal(before.status)) continue;
        expect(result).toEqual({ run: before, effect: null, consumed: false, captured: null, log: [] });
        expect(result.run).toBe(before);
      }
    });
  });

  it('never repeats an effect key and never moves backwards', () => {
    property((history) => {
      const keys = new Set<string>();
      for (const { before, result } of history) {
        expect(result.run.stepIndex).toBeGreaterThanOrEqual(before.stepIndex);
        if (result.effect === null) continue;
        expect(keys.has(result.effect.key)).toBe(false);
        keys.add(result.effect.key);
      }
    });
  });

  it('returns the same reference for a no-op, and a stamped, logged run for a change', () => {
    property((history) => {
      for (const { before, at, result } of history) {
        if (result.run === before) {
          expect(result).toEqual({ run: before, effect: null, consumed: false, captured: null, log: [] });
        } else {
          expect(result.run.updatedAt).toBe(at);
          expect(result.log.length).toBeGreaterThan(0);
        }
      }
    });
  });

  it('sends at most one private reply per run, never once the window is open', () => {
    property((history) => {
      let privateReplies = 0;
      for (const { before, result } of history) {
        if (result.effect?.kind !== 'private_reply') continue;
        privateReplies++;
        expect(before.windowOpen).toBe(false);
        expect(result.run.windowOpen).toBe(false);
      }
      expect(privateReplies).toBeLessThanOrEqual(1);
    });
  });
});
