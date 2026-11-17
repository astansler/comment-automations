import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractEmail,
  matchesTrigger,
  newRun,
  renderTemplate,
  transition,
  validateDefinition,
} from '../src/core/engine.js';
import type {
  AskStep,
  AutomationDefinition,
  AutomationVersion,
  InboundComment,
  Run,
  RunEvent,
  Step,
  TransitionResult,
} from '../src/core/types.js';

const loadPricing = (): AutomationDefinition => {
  const result = validateDefinition(JSON.parse(readFileSync(new URL('../examples/pricing.json', import.meta.url), 'utf8')));
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.definition;
};

const pricing = loadPricing();

const version = (definition: AutomationDefinition, overrides: Partial<AutomationVersion> = {}): AutomationVersion => ({
  id: 'v1',
  automationId: 'a1',
  accountId: 'acct',
  enabled: true,
  cooldownSeconds: 0,
  definition,
  ...overrides,
});

const comment = (overrides: Partial<InboundComment> = {}): InboundComment => ({
  eventId: 'e1',
  accountId: 'acct',
  commentId: 'c1',
  postId: 'p1',
  authorId: 'u1',
  text: 'pricing',
  at: 0,
  ...overrides,
});

const T0 = 1_000_000;

const queued = (definition: AutomationDefinition = pricing): Run =>
  newRun({ id: 'r1', version: version(definition), comment: comment(), now: T0 });

/** Feeds events in order, checking that each one produced a change. */
const drive = (definition: AutomationDefinition, run: Run, events: [RunEvent, number][]): TransitionResult[] => {
  const results: TransitionResult[] = [];
  for (const [event, now] of events) {
    const result = transition(definition, run, event, now);
    results.push(result);
    run = result.run;
  }
  return results;
};

const last = (results: TransitionResult[]): TransitionResult => results[results.length - 1]!;

const start: RunEvent = { type: 'start', known: {} };
const ok = (key: string): RunEvent => ({ type: 'effect_succeeded', key });
const msg = (text: string): RunEvent => ({ type: 'message_received', messageId: 'm', text });

const ask = (overrides: Partial<AskStep> = {}): AskStep => ({
  type: 'ask',
  prompt: 'Email?',
  capture: 'email',
  saveAs: 'email',
  timeoutSeconds: 3600,
  maxAttempts: 3,
  repromptText: 'Again?',
  ...overrides,
});

const definitionOf = (...steps: Step[]): AutomationDefinition => ({ ...pricing, steps });

/** Pricing run that has sent its prompt and is waiting for the reply. */
const waitingOnEmail = (): Run =>
  last(drive(pricing, queued(), [[start, T0], [ok('r1:0:0'), T0 + 1], [ok('r1:1:0'), T0 + 2]])).run;

describe('transition: pricing.json', () => {
  it('runs the happy path event by event', () => {
    let run = queued();
    expect(run).toMatchObject({ status: 'queued', contactId: 'u1', triggerCommentId: 'c1', createdAt: T0 });

    let r = transition(pricing, run, start, T0 + 10);
    expect(r.effect).toEqual({ key: 'r1:0:0', kind: 'reply_to_comment', text: 'Sent you a DM!' });
    expect(r.run).toMatchObject({ status: 'awaiting_effect', stepIndex: 0, pendingEffectKey: 'r1:0:0', startedAt: T0 + 10 });
    run = r.run;

    r = transition(pricing, run, ok('r1:0:0'), T0 + 20);
    expect(r.effect).toMatchObject({ key: 'r1:1:0', kind: 'private_reply' });
    expect(r.effect?.text).toContain('email');
    expect(r.log).toContain('step 1 ask: prompt sent as private_reply');
    run = r.run;

    r = transition(pricing, run, ok('r1:1:0'), T0 + 30);
    expect(r.effect).toBeNull();
    expect(r.run).toMatchObject({ status: 'waiting_reply', pendingEffectKey: null, wakeAt: T0 + 30 + 82_800_000 });
    run = r.run;

    r = transition(pricing, run, msg("sure, it's Jane.Doe+ig@Example.co.uk!"), T0 + 40);
    expect(r.consumed).toBe(true);
    expect(r.captured).toEqual({ field: 'email', value: 'jane.doe+ig@example.co.uk' });
    expect(r.effect).toMatchObject({ key: 'r1:2:0', kind: 'direct_message' });
    expect(r.run).toMatchObject({ windowOpen: true, wakeAt: null, attempt: 0, context: { email: 'jane.doe+ig@example.co.uk' } });
    expect(r.log.join('\n')).not.toContain('jane');
    run = r.run;

    r = transition(pricing, run, ok('r1:2:0'), T0 + 50);
    expect(r.run).toMatchObject({ status: 'completed', outcome: 'completed', stepIndex: 3, pendingEffectKey: null, updatedAt: T0 + 50 });
  });

  it('reprompts on a reply without an email, then captures', () => {
    const results = drive(pricing, waitingOnEmail(), [
      [msg('no thanks'), T0 + 100],
      [ok('r1:1:1'), T0 + 110],
      [msg('ok: a@b.co'), T0 + 120],
    ]);
    const [reprompt, delivered, captured] = results;
    expect(reprompt?.consumed).toBe(true);
    expect(reprompt?.effect).toEqual({
      key: 'r1:1:1',
      kind: 'direct_message',
      text: "I couldn't spot an email address in that. Could you send it again?",
    });
    expect(reprompt?.run).toMatchObject({ status: 'awaiting_effect', attempt: 1 });
    expect(delivered?.run.status).toBe('waiting_reply');
    expect(captured?.captured).toEqual({ field: 'email', value: 'a@b.co' });
    expect(captured?.effect?.key).toBe('r1:2:0');
  });

  it('fails with no_valid_reply once attempts are exhausted', () => {
    const r = last(
      drive(pricing, waitingOnEmail(), [
        [msg('no'), T0 + 100],
        [ok('r1:1:1'), T0 + 101],
        [msg('still no'), T0 + 102],
        [ok('r1:1:2'), T0 + 103],
        [msg('never'), T0 + 104],
      ]),
    );
    expect(r.consumed).toBe(true);
    expect(r.effect).toBeNull();
    expect(r.run).toMatchObject({ status: 'failed', outcome: 'no_valid_reply', wakeAt: null, pendingEffectKey: null });
  });

  it('expires when the timer fires at the deadline, and ignores an early timer', () => {
    const run = waitingOnEmail();
    const early = transition(pricing, run, { type: 'timer_fired' }, run.wakeAt! - 1);
    expect(early.run).toBe(run);
    expect(early.log).toEqual([]);
    const due = transition(pricing, run, { type: 'timer_fired' }, run.wakeAt!);
    expect(due.run).toMatchObject({ status: 'expired', outcome: 'timeout', wakeAt: null });
    expect(due.log).toEqual(['expired: timeout']);
  });

  it('does not move the deadline when a reprompt is delivered', () => {
    const run = waitingOnEmail();
    const r = last(drive(pricing, run, [[msg('no'), T0 + 5_000], [ok('r1:1:1'), T0 + 9_000]]));
    expect(r.run.status).toBe('waiting_reply');
    expect(r.run.wakeAt).toBe(run.wakeAt);
  });

  it('skips a known email and sends the final DM as the private reply', () => {
    const results = drive(pricing, queued(), [
      [{ type: 'start', known: { email: 'x@y.co' } }, T0],
      [ok('r1:0:0'), T0 + 1],
    ]);
    const r = last(results);
    expect(r.effect).toMatchObject({ key: 'r1:2:0', kind: 'private_reply' });
    expect(r.log).toEqual(['step 0 reply_to_comment: delivered', 'step 1 ask: skipped, email already known', 'step 2 send_dm: message sent as private_reply']);
  });

  it('known fields do not override existing context', () => {
    const run = { ...queued(), context: { email: 'old@x.co' } };
    expect(transition(pricing, run, { type: 'start', known: { email: 'new@x.co' } }, T0).run.context).toEqual({ email: 'old@x.co' });
  });

  it('opens the window on a message while awaiting an effect, without consuming it', () => {
    const run = last(drive(pricing, queued(), [[start, T0]])).run;
    const r = transition(pricing, run, msg('a@b.co'), T0 + 1);
    expect(r.consumed).toBe(false);
    expect(r.run).toMatchObject({ windowOpen: true, status: 'awaiting_effect', pendingEffectKey: 'r1:0:0' });
    expect(transition(pricing, r.run, msg('again'), T0 + 2).run).toBe(r.run);
    // The prompt now goes out as an ordinary DM.
    expect(transition(pricing, r.run, ok('r1:0:0'), T0 + 3).effect?.kind).toBe('direct_message');
  });

  it('ignores messages for queued and terminal runs', () => {
    const run = queued();
    const r = transition(pricing, run, msg('hi'), T0);
    expect(r).toEqual({ run, effect: null, consumed: false, captured: null, log: [] });
    expect(r.run).toBe(run);
  });

  it('treats duplicate and stale effect results as no-ops returning the same reference', () => {
    const [first, second] = drive(pricing, queued(), [[start, T0], [ok('r1:0:0'), T0 + 1]]);
    const awaitingPrompt = second!.run;
    for (const event of [ok('r1:0:0'), ok('other'), { type: 'effect_failed', key: 'r1:0:0', code: 'x' } as const]) {
      expect(transition(pricing, awaitingPrompt, event, T0 + 2).run).toBe(awaitingPrompt);
    }
    expect(transition(pricing, first!.run, start, T0 + 2).run).toBe(first!.run);
  });

  it('continues past a failed public reply but fails the run on a failed DM', () => {
    const run = last(drive(pricing, queued(), [[start, T0]])).run;
    const replyFailed = transition(pricing, run, { type: 'effect_failed', key: 'r1:0:0', code: 'comment_deleted' }, T0 + 1);
    expect(replyFailed.effect?.key).toBe('r1:1:0');
    expect(replyFailed.log[0]).toBe('step 0 reply_to_comment: send failed (comment_deleted), continuing');

    const dmFailed = transition(pricing, replyFailed.run, { type: 'effect_failed', key: 'r1:1:0', code: 'blocked' }, T0 + 2);
    expect(dmFailed.run).toMatchObject({ status: 'failed', outcome: 'effect_failed:blocked', pendingEffectKey: null });
  });

  it('cancels any non-terminal run and ignores cancel once terminal', () => {
    const cancelled = transition(pricing, waitingOnEmail(), { type: 'cancel', reason: 'user' }, T0 + 9);
    expect(cancelled.run).toMatchObject({ status: 'cancelled', outcome: 'cancelled:user', wakeAt: null });
    expect(transition(pricing, queued(), { type: 'cancel', reason: 'x' }, T0).run.status).toBe('cancelled');
    expect(transition(pricing, cancelled.run, { type: 'cancel', reason: 'again' }, T0 + 10).run).toBe(cancelled.run);
  });

  it('fails a run whose step index does not fit its state', () => {
    const corrupt: Run = { ...waitingOnEmail(), stepIndex: 2 };
    expect(transition(pricing, corrupt, msg('a@b.co'), T0).run).toMatchObject({ status: 'failed', outcome: 'invalid_state' });
    const outOfRange: Run = { ...corrupt, status: 'awaiting_effect', stepIndex: 9, pendingEffectKey: 'k' };
    expect(transition(pricing, outOfRange, ok('k'), T0).run.outcome).toBe('invalid_state');
  });

  it('renders captured fields into later messages', () => {
    const def = definitionOf(ask({ capture: 'any', saveAs: 'name' }), { type: 'send_dm', text: 'Hi {{ name }}!' });
    const r = last(drive(def, queued(def), [[start, T0], [ok('r1:0:0'), T0], [msg('  Ann  '), T0]]));
    expect(r.effect?.text).toBe('Hi Ann!');
    expect(renderTemplate('{{a}}-{{b}}', { a: '1' })).toBe('1-');
  });
});

describe('matchesTrigger', () => {
  const contains = version(pricing);
  const exact = version({ ...pricing, trigger: { ...pricing.trigger, match: 'exact', keywords: ['pricing', 'Price List'] } });
  const multi = version({ ...pricing, trigger: { ...pricing.trigger, keywords: ['price list', 'a.b'] } });

  it.each<[string, AutomationVersion, Partial<InboundComment>, boolean]>([
    ['plain keyword', contains, {}, true],
    ['trailing punctuation', contains, { text: 'pricing?' }, true],
    ['case and surrounding words', contains, { text: 'PRICING please' }, true],
    ['fullwidth letters (NFKC)', contains, { text: 'ｐｒｉｃｉｎｇ' }, true],
    ['inside another word', contains, { text: 'repricing' }, false],
    ['prefix of another word', contains, { text: 'pricings' }, false],
    ['next to a non-Latin letter', contains, { text: 'épricing' }, false],
    ['missing keyword', contains, { text: 'how much?' }, false],
    ['own comment', contains, { authorId: 'acct', accountId: 'acct' }, false],
    ['other account', contains, { accountId: 'other' }, false],
    ['disabled', version(pricing, { enabled: false }), {}, false],
    ['post in filter', version({ ...pricing, trigger: { ...pricing.trigger, postIds: ['p1'] } }), {}, true],
    ['post not in filter', version({ ...pricing, trigger: { ...pricing.trigger, postIds: ['p2'] } }), {}, false],
    ['multi-word with extra spaces', multi, { text: 'send the  PRICE\nlist pls' }, true],
    ['regex metacharacters are literal', multi, { text: 'aXb' }, false],
    ['regex metacharacters match themselves', multi, { text: 'a.b' }, true],
    ['exact with punctuation and case', exact, { text: '  Pricing!! ' }, true],
    ['exact multi-word', exact, { text: 'price   list' }, true],
    ['exact rejects extra words', exact, { text: 'pricing please' }, false],
  ])('%s', (_, v, overrides, expected) => {
    expect(matchesTrigger(v, comment(overrides))).toBe(expected);
  });
});

describe('validateDefinition', () => {
  const dm = (text = 'Hello'): Step => ({ type: 'send_dm', text });
  const valid = (...steps: Step[]) => validateDefinition(definitionOf(...steps));

  it('accepts the example', () => {
    expect(validateDefinition(pricing).ok).toBe(true);
  });

  it.each<[string, Step[], boolean]>([
    ['[send_dm, send_dm]', [dm(), dm()], false],
    ['[send_dm, ask]', [dm(), ask()], false],
    ['[ask, send_dm, send_dm]', [ask(), dm(), dm()], true],
    ['[ask(skipIfKnown), send_dm]', [ask({ skipIfKnown: true }), dm()], true],
    ['[ask(skipIfKnown), send_dm, send_dm]', [ask({ skipIfKnown: true }), dm(), dm()], false],
    ['[reply, reply, send_dm]', [{ type: 'reply_to_comment', text: 'a' }, { type: 'reply_to_comment', text: 'b' }, dm()], true],
  ])('private-reply budget %s', (_, steps, expected) => {
    expect(valid(...steps).ok).toBe(expected);
  });

  it('names the offending step', () => {
    expect(valid(ask({ skipIfKnown: true }), dm(), dm())).toEqual({
      ok: false,
      errors: [expect.stringMatching(/^steps\.2: send_dm /)],
    });
  });

  it('requires templates to reference fields captured earlier', () => {
    expect(valid(ask({ saveAs: 'email' }), dm('Sent to {{email}}')).ok).toBe(true);
    const result = valid(ask({ prompt: 'Hi {{name}}', repromptText: '{{email}}?' }), dm('{{ email }} {{city}}'));
    expect(result).toEqual({
      ok: false,
      errors: [
        'steps.0: {{name}} is not captured by an earlier ask step',
        'steps.0: {{email}} is not captured by an earlier ask step',
        'steps.1: {{city}} is not captured by an earlier ask step',
      ],
    });
  });

  it('collects shape errors without throwing', () => {
    const result = validateDefinition({
      trigger: { ...pricing.trigger, keywords: ['  '], extra: 1 },
      steps: [ask({ timeoutSeconds: 59, maxAttempts: 6, saveAs: 'Email', prompt: '' })],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const path of ['trigger', 'trigger.keywords.0', 'steps.0.timeoutSeconds', 'steps.0.maxAttempts', 'steps.0.saveAs', 'steps.0.prompt']) {
      expect(result.errors.some((e) => e.startsWith(`${path}: `))).toBe(true);
    }
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a string', 'pricing'],
    ['no steps', { ...pricing, steps: [] }],
    ['21 steps', { ...pricing, steps: Array.from({ length: 21 }, () => ({ type: 'reply_to_comment', text: 'x' })) }],
    ['unknown step type', { ...pricing, steps: [{ type: 'wait', seconds: 5 }] }],
    ['unknown step key', { ...pricing, steps: [{ type: 'send_dm', text: 'x', delay: 1 }] }],
    ['text over 1000 chars', { ...pricing, steps: [dm('x'.repeat(1001))] }],
    ['fractional timeout', { ...pricing, steps: [ask({ timeoutSeconds: 60.5 })] }],
    ['21 keywords', { ...pricing, trigger: { ...pricing.trigger, keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) } }],
  ])('rejects %s', (_, input) => {
    expect(validateDefinition(input).ok).toBe(false);
  });
});

describe('extractEmail', () => {
  it.each<[string, string | null]>([
    ["sure, it's Jane.Doe+ig@Example.co.uk!", 'jane.doe+ig@example.co.uk'],
    ['a@b.co', 'a@b.co'],
    ['mail me at x_y@sub.domain.com.', 'x_y@sub.domain.com'],
    ['<first@one.io> or second@two.io', 'first@one.io'],
    ['(me@site.org)', 'me@site.org'],
    ['no thanks', null],
    ['@handle', null],
    ['a@b', null],
    ['a@b.c', null],
    ['a..b@x.com', null],
    ['a@x..com', null],
    ['a@-x.com', null],
    ['a@b.co1', null],
  ])('%j -> %j', (text, expected) => {
    expect(extractEmail(text)).toBe(expected);
  });
});
