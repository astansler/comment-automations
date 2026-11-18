import { z } from 'zod';
import type {
  ExtractEmail,
  MatchesTrigger,
  NewRun,
  Transition,
  ValidateDefinition,
} from './engine.contract.js';
import { isActive, isTerminal } from './types.js';
import type {
  AutomationDefinition,
  EffectKind,
  EffectRequest,
  Millis,
  Run,
  RunEvent,
  RunStatus,
  Step,
  TransitionResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const TEMPLATE = /\{\{\s*(\w+)\s*\}\}/g;

/** Replaces `{{name}}` with `context[name]`; unknown names render as empty. */
export const renderTemplate = (text: string, context: Readonly<Record<string, string>>): string =>
  text.replace(TEMPLATE, (_, name: string) => context[name] ?? '');

const templateNames = (text: string): string[] => [...text.matchAll(TEMPLATE)].map((m) => m[1] ?? '');

// ---------------------------------------------------------------------------
// transition
// ---------------------------------------------------------------------------

type Change = Omit<TransitionResult, 'run'> & { run: Run };

const noop = (run: Run): TransitionResult => ({ run, effect: null, consumed: false, captured: null, log: [] });

const change = (run: Run, log: string[], extra: Partial<Omit<Change, 'run' | 'log'>> = {}): Change => ({
  run,
  effect: null,
  consumed: false,
  captured: null,
  log,
  ...extra,
});

const finish = (run: Run, status: RunStatus, outcome: string): Run => ({
  ...run,
  status,
  outcome,
  pendingEffectKey: null,
  wakeAt: null,
});

const fail = (run: Run, outcome: string, log: string[] = []): Change =>
  change(finish(run, 'failed', outcome), [...log, `failed: ${outcome}`]);

const dmKind = (run: Run): EffectKind => (run.windowOpen ? 'direct_message' : 'private_reply');

/** The idempotency key of a step's send: attempt 0 is its first send, n its nth reprompt. */
export const effectKey = (runId: string, stepIndex: number, attempt: number): string =>
  `${runId}:${stepIndex}:${attempt}`;

const emit = (
  run: Run,
  stepIndex: number,
  attempt: number,
  kind: EffectKind,
  text: string,
): { run: Run; effect: EffectRequest } => {
  const key = effectKey(run.id, stepIndex, attempt);
  return {
    run: { ...run, status: 'awaiting_effect', stepIndex, attempt, pendingEffectKey: key },
    effect: { key, kind, text },
  };
};

/** Runs steps from `from` until one emits an effect or the program ends. Skipped steps chain. */
const advance = (steps: readonly Step[], current: Run, from: number, logSoFar: string[]): Change => {
  const run: Run = { ...current, attempt: 0, wakeAt: null };
  const log = [...logSoFar];
  for (let i = from; i < steps.length; i++) {
    const step = steps[i]!;
    switch (step.type) {
      case 'reply_to_comment': {
        const sent = emit(run, i, 0, 'reply_to_comment', step.text);
        return change(sent.run, [...log, `step ${i} reply_to_comment: reply sent`], { effect: sent.effect });
      }
      case 'send_dm': {
        const kind = dmKind(run);
        const sent = emit(run, i, 0, kind, renderTemplate(step.text, run.context));
        return change(sent.run, [...log, `step ${i} send_dm: message sent as ${kind}`], { effect: sent.effect });
      }
      case 'ask': {
        if (step.skipIfKnown && run.context[step.saveAs]) {
          log.push(`step ${i} ask: skipped, ${step.saveAs} already known`);
          continue;
        }
        const kind = dmKind(run);
        const sent = emit(run, i, 0, kind, renderTemplate(step.prompt, run.context));
        return change(sent.run, [...log, `step ${i} ask: prompt sent as ${kind}`], { effect: sent.effect });
      }
    }
  }
  return change(finish({ ...run, stepIndex: steps.length }, 'completed', 'completed'), [...log, 'completed']);
};

const capture = (kind: 'email' | 'any', text: string): string | null => {
  if (kind === 'email') return extractEmail(text);
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
};

const apply = (steps: readonly Step[], run: Run, event: RunEvent, now: Millis): Change | null => {
  switch (event.type) {
    case 'start': {
      if (run.status !== 'queued') return null;
      const started: Run = { ...run, context: { ...event.known, ...run.context }, startedAt: now };
      return advance(steps, started, 0, ['started']);
    }

    case 'effect_succeeded': {
      if (run.status !== 'awaiting_effect' || event.key !== run.pendingEffectKey) return null;
      const step = steps[run.stepIndex];
      if (step === undefined) return fail(run, 'invalid_state');
      if (step.type !== 'ask') return advance(steps, run, run.stepIndex + 1, [`step ${run.stepIndex} ${step.type}: delivered`]);
      return change(
        {
          ...run,
          status: 'waiting_reply',
          pendingEffectKey: null,
          // A reprompt is delivered with a deadline already running; it must not extend it.
          wakeAt: run.wakeAt ?? now + step.timeoutSeconds * 1000,
        },
        [`step ${run.stepIndex} ask: waiting for reply`],
      );
    }

    case 'effect_failed': {
      if (run.status !== 'awaiting_effect' || event.key !== run.pendingEffectKey) return null;
      const step = steps[run.stepIndex];
      if (step === undefined) return fail(run, 'invalid_state');
      const line = `step ${run.stepIndex} ${step.type}: send failed (${event.code})`;
      // The public reply is a courtesy; losing it must not cost the lead.
      if (step.type === 'reply_to_comment') return advance(steps, run, run.stepIndex + 1, [line + ', continuing']);
      return fail(run, `effect_failed:${event.code}`, [line]);
    }

    case 'message_received': {
      if (!isActive(run.status)) return null;
      if (run.status !== 'waiting_reply') {
        return run.windowOpen ? null : change({ ...run, windowOpen: true }, ['conversation window opened']);
      }
      const step = steps[run.stepIndex];
      if (step?.type !== 'ask') return fail(run, 'invalid_state');
      const opened: Run = { ...run, windowOpen: true };
      const value = capture(step.capture, event.text);
      // Written before the question was delivered: an email sent unprompted is still
      // the answer, but "hi" is not a failed attempt, and for a free-text
      // question nothing written earlier can be the answer.
      if (event.beforePrompt === true && (value === null || step.capture === 'any')) {
        return run.windowOpen ? null : change(opened, ['conversation window opened']);
      }
      if (value !== null) {
        const captured: Run = { ...opened, context: { ...opened.context, [step.saveAs]: value } };
        return {
          ...advance(steps, captured, run.stepIndex + 1, [`captured ${step.saveAs}`]),
          consumed: true,
          captured: { field: step.saveAs, value },
        };
      }
      const attempt = run.attempt + 1;
      const line = `step ${run.stepIndex} ask: nothing to capture (attempt ${attempt}/${step.maxAttempts})`;
      if (attempt >= step.maxAttempts) return { ...fail(opened, 'no_valid_reply', [line]), consumed: true };
      const sent = emit(opened, run.stepIndex, attempt, 'direct_message', renderTemplate(step.repromptText, run.context));
      return change(sent.run, [line, `step ${run.stepIndex} ask: reprompt sent as direct_message`], {
        effect: sent.effect,
        consumed: true,
      });
    }

    case 'timer_fired': {
      if (run.status !== 'waiting_reply' || run.wakeAt === null || now < run.wakeAt) return null;
      return change(finish(run, 'expired', 'timeout'), ['expired: timeout']);
    }

    case 'cancel':
      return change(finish(run, 'cancelled', `cancelled:${event.reason}`), [`cancelled: ${event.reason}`]);
  }
};

export const transition: Transition = (definition, run, event, now) => {
  if (isTerminal(run.status)) return noop(run);
  const result = apply(definition.steps, run, event, now);
  return result === null ? noop(run) : { ...result, run: { ...result.run, updatedAt: now } };
};

// ---------------------------------------------------------------------------
// matchesTrigger
// ---------------------------------------------------------------------------

const normalise = (text: string): string => text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');

const stripPunctuation = (text: string): string => text.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const matchesTrigger: MatchesTrigger = (version, comment) => {
  const { trigger } = version.definition;
  if (!version.enabled || comment.accountId !== version.accountId) return false;
  // Our own replies ("Sent you a DM!") arrive as comments too and must never re-trigger.
  if (comment.authorId === comment.accountId) return false;
  if (trigger.postIds !== 'any' && !trigger.postIds.includes(comment.postId)) return false;

  const text = normalise(comment.text);
  return trigger.keywords.some((raw) => {
    const keyword = normalise(raw);
    if (trigger.match === 'exact') {
      const bare = stripPunctuation(keyword);
      return bare !== '' && stripPunctuation(text) === bare;
    }
    if (keyword === '') return false;
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(keyword)}(?![\\p{L}\\p{N}])`, 'u').test(text);
  });
};

// ---------------------------------------------------------------------------
// extractEmail
// ---------------------------------------------------------------------------

// Lookarounds stop a match from starting or ending mid-token, so "a..b@x.co"
// is rejected rather than shortened to "b@x.co".
const EMAIL =
  /(?<![\w.%+-])[\w%+-]+(?:\.[\w%+-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?![a-z0-9-])/i;

export const extractEmail: ExtractEmail = (text) => EMAIL.exec(text)?.[0].toLowerCase() ?? null;

// ---------------------------------------------------------------------------
// validateDefinition
// ---------------------------------------------------------------------------

const message = z.string().min(1).max(1000);

const definitionSchema = z.strictObject({
  trigger: z.strictObject({
    type: z.literal('comment_keyword'),
    platform: z.literal('instagram'),
    keywords: z
      .array(z.string().refine((k) => k.trim() !== '', 'keyword must not be blank'))
      .min(1)
      .max(20),
    match: z.enum(['contains', 'exact']),
    postIds: z.union([z.literal('any'), z.array(z.string().min(1)).min(1)]),
  }),
  steps: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('reply_to_comment'), text: message }),
        z.strictObject({ type: z.literal('send_dm'), text: message }),
        z.strictObject({
          type: z.literal('ask'),
          prompt: message,
          capture: z.enum(['email', 'any']),
          saveAs: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
          timeoutSeconds: z.int().min(60).max(604_800),
          maxAttempts: z.int().min(1).max(5),
          repromptText: message,
          skipIfKnown: z.boolean().exactOptional(),
        }),
      ]),
    )
    .min(1)
    .max(20),
}) satisfies z.ZodType<AutomationDefinition>;

const stepTexts = (step: Step): string[] =>
  step.type === 'ask' ? [step.prompt, step.repromptText] : [step.text];

const templateErrors = (steps: readonly Step[]): string[] => {
  const errors: string[] = [];
  const captured = new Set<string>();
  steps.forEach((step, i) => {
    for (const name of new Set(stepTexts(step).flatMap(templateNames))) {
      if (!captured.has(name)) errors.push(`steps.${i}: {{${name}}} is not captured by an earlier ask step`);
    }
    if (step.type === 'ask') captured.add(step.saveAs);
  });
  return errors;
};

interface Budget {
  privateReplyUsed: boolean;
  windowOpen: boolean;
}

/** The DM a closed window allows, or null when the one private reply is already spent. */
const spendDm = (b: Budget): Budget | null =>
  b.windowOpen ? b : b.privateReplyUsed ? null : { ...b, privateReplyUsed: true };

const dedupe = (states: Budget[]): Budget[] =>
  [...new Map(states.map((s) => [`${s.privateReplyUsed}:${s.windowOpen}`, s])).values()];

/**
 * Abstract interpretation over the set of reachable (privateReplyUsed,
 * windowOpen) states. An `ask` with `skipIfKnown` forks; a run only gets past
 * an `ask` it executed if the contact replied, which opens the window.
 */
const budgetErrors = (steps: readonly Step[]): string[] => {
  const errors: string[] = [];
  let states: Budget[] = [{ privateReplyUsed: false, windowOpen: false }];
  steps.forEach((step, i) => {
    if (step.type === 'reply_to_comment' || states.length === 0) return;
    const sent = states.map(spendDm);
    if (sent.includes(null)) {
      errors.push(
        `steps.${i}: ${step.type} can run before the contact has replied, after the one private reply allowed per comment was already used`,
      );
    }
    const delivered = sent.filter((s): s is Budget => s !== null);
    if (step.type === 'send_dm') states = delivered;
    else {
      const asked = delivered.map((s) => ({ ...s, windowOpen: true }));
      states = dedupe(step.skipIfKnown ? [...states, ...asked] : asked);
    }
  });
  return errors;
};

export const validateDefinition: ValidateDefinition = (input) => {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) =>
        issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
      ),
    };
  }
  const definition: AutomationDefinition = parsed.data;
  const errors = [...templateErrors(definition.steps), ...budgetErrors(definition.steps)];
  return errors.length === 0 ? { ok: true, definition } : { ok: false, errors };
};

// ---------------------------------------------------------------------------
// newRun
// ---------------------------------------------------------------------------

export const newRun: NewRun = ({ id, version, comment, now }) => ({
  id,
  automationId: version.automationId,
  versionId: version.id,
  accountId: version.accountId,
  contactId: comment.authorId,
  triggerCommentId: comment.commentId,
  status: 'queued',
  stepIndex: 0,
  attempt: 0,
  context: {},
  windowOpen: false,
  pendingEffectKey: null,
  wakeAt: null,
  outcome: null,
  createdAt: now,
  startedAt: null,
  updatedAt: now,
});
