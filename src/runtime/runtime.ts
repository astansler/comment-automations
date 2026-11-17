/**
 * The imperative shell around the pure engine: it feeds events to
 * `transition`, persists what comes back, and drives the outbox and timers.
 *
 * Every change to a run happens in one transaction that holds the run's
 * conversation lock (see store.ts). Network calls happen with no transaction
 * open, so the crash windows are all of the form "the platform did something
 * we have not recorded yet"; the effect's delivery policy decides how each one
 * is resolved.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { matchesTrigger, newRun, transition, validateDefinition } from '../core/engine.js';
import {
  DELIVERY_POLICY,
  isTerminal,
  type AutomationVersion,
  type InboundComment,
  type InboundMessageEvent,
  type Millis,
  type Run,
  type RunEvent,
  type RunStatus,
  type TransitionResult,
} from '../core/types.js';
import type { ClaimedEffect, Store, StoredEffect, Tx } from '../store/store.js';
import type { PlatformAdapter, SendResult } from './adapter.js';

export interface RuntimeConfig {
  leaseMs: number;
  maxEffectAttempts: number;
  batchSize: number;
  backoffMs: (attempt: number) => number;
  /** Used when a rate-limit error carries no `retryAfterMs`. */
  defaultThrottleMs: number;
}

const DEFAULT_CONFIG: RuntimeConfig = {
  leaseMs: 60_000,
  maxEffectAttempts: 5,
  batchSize: 20,
  backoffMs: (attempt) => Math.min(1_000 * 2 ** (attempt - 1), 5 * 60_000),
  defaultThrottleMs: 60_000,
};

/** A version as it arrives from a customer or an agent: the definition is untrusted until validated. */
export type VersionInput = Omit<AutomationVersion, 'definition'> & { definition: unknown };

export type PublishResult = { status: 'published' } | { status: 'invalid'; errors: string[] };

export type TriggerResult =
  | { automationId: string; status: 'created'; runId: string }
  | { automationId: string; status: 'already_triggered'; runId: string }
  | { automationId: string; status: 'cooldown' };

export type CommentResult =
  | { status: 'duplicate' }
  | { status: 'no_match' }
  | { status: 'matched'; triggers: TriggerResult[] };

export type MessageResult =
  | { status: 'echo' }
  | { status: 'duplicate' }
  /** No run owns the conversation: the message stays unconsumed, for the human inbox. */
  | { status: 'unmatched' }
  | { status: 'delivered'; runId: string; consumed: boolean };

export type CancelResult =
  | { status: 'not_found' }
  | { status: 'already_ended'; runStatus: RunStatus }
  | { status: 'cancelled' };

/** How one tick left a claimed effect. */
export type EffectOutcome =
  | 'sent'
  | 'failed'
  /** Back to `pending` for a later attempt. */
  | 'retrying'
  /** Not attempted: an earlier effect in the same tick hit this account's rate limit. */
  | 'deferred'
  /** Left `sending` after an unknown outcome; reconciled once its lease lapses. */
  | 'in_doubt'
  /** Another worker settled or reclaimed it first; nothing written. */
  | 'superseded';

export interface TickReport {
  effects: Record<EffectOutcome, number>;
  /** Due timers handed to their runs. */
  timers: number;
}

export const isIdle = (report: TickReport): boolean =>
  report.timers === 0 && Object.values(report.effects).every((n) => n === 0);

export interface Runtime {
  publishVersion(version: VersionInput): Promise<PublishResult>;
  ingestComment(comment: InboundComment): Promise<CommentResult>;
  ingestMessage(message: InboundMessageEvent): Promise<MessageResult>;
  cancelRun(runId: string, reason: string): Promise<CancelResult>;
  /** One worker pass over due effects and due timers. */
  tick(): Promise<TickReport>;
}

type Settlement =
  | { status: 'sent'; providerId: string | null; note: string | null }
  | { status: 'failed'; code: string };

interface Retry {
  /** null keeps the effect's place in the queue. */
  delayMs: Millis | null;
  lastError: string | null;
  /** False when the failure was not the effect's fault (rate limit), so it does not use up an attempt. */
  countAttempt: boolean;
  throttleMs: Millis | null;
}

export function createRuntime(deps: {
  store: Store;
  adapter: PlatformAdapter;
  now: () => Millis;
  newId: () => string;
  config?: Partial<RuntimeConfig>;
}): Runtime {
  const { store, adapter, now, newId } = deps;
  const config: RuntimeConfig = { ...DEFAULT_CONFIG, ...deps.config };

  // -- dispatch: the only path by which a run changes ----------------------------
  // All of these run inside a transaction that holds the run's conversation lock.

  /** One transition, persisted. Follow-ups (drain, promote) are the caller's. */
  async function apply(tx: Tx, at: Millis, run: Run, event: RunEvent): Promise<TransitionResult> {
    // Runs are pinned to the version they started on.
    const version = await tx.getVersion(run.versionId);
    if (version === null) throw new Error(`run ${run.id}: version ${run.versionId} not found`);
    const result = transition(version.definition, run, event, at);
    if (result.run === run) return result;

    const next = result.run;
    await tx.updateRun(next);
    for (const entry of result.log) await tx.appendRunLog(next.id, at, entry);
    if (result.captured !== null) {
      await tx.upsertLead(next.accountId, next.contactId, result.captured.field, result.captured.value, at);
    }
    if (result.effect !== null) {
      const { key, kind, text } = result.effect;
      await tx.insertEffect({
        key,
        runId: next.id,
        accountId: next.accountId,
        contactId: next.contactId,
        commentId: next.triggerCommentId,
        kind,
        policy: DELIVERY_POLICY[kind],
        text,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        leaseUntil: null,
        providerId: null,
        lastError: null,
        createdAt: at,
        updatedAt: at,
      });
    }
    return result;
  }

  async function dispatch(tx: Tx, at: Millis, run: Run, event: RunEvent): Promise<TransitionResult> {
    const result = await apply(tx, at, run, event);
    if (result.run === run) return result;
    if (result.run.status === 'waiting_reply') await drain(tx, at, result.run);
    else if (isTerminal(result.run.status)) await promote(tx, at, run.accountId, run.contactId);
    return result;
  }

  /**
   * Feeds stored replies to a run that has just started waiting, oldest first.
   * A reply that arrived while the prompt was still unacknowledged (fast user,
   * slow worker) is answered exactly as if it had arrived a moment later.
   *
   * Terminates: the list is finite, and a waiting run consumes every message it
   * is given and stops waiting (it captures, reprompts or fails), so the loop
   * feeds at most one message before breaking.
   */
  async function drain(tx: Tx, at: Millis, waiting: Run): Promise<void> {
    const since = waiting.startedAt ?? waiting.createdAt;
    let run = waiting;
    for (const message of await tx.listUnconsumedMessages(run.accountId, run.contactId, since)) {
      if (run.status !== 'waiting_reply') break;
      const result = await apply(tx, at, run, { type: 'message_received', messageId: message.id, text: message.text });
      if (result.consumed) await tx.markMessageConsumed(message.id, run.id);
      run = result.run;
    }
    if (isTerminal(run.status)) await promote(tx, at, run.accountId, run.contactId);
  }

  /**
   * Hands a free conversation to its queued runs, oldest first, until one keeps
   * it. A run can end on start (every step skipped), hence the loop. It ends:
   * each pass takes one run out of `queued`. No drain is needed, because start
   * never leaves a run `waiting_reply` (waiting begins only once a prompt has
   * been delivered).
   */
  async function promote(tx: Tx, at: Millis, accountId: string, contactId: string): Promise<void> {
    if ((await tx.findActiveRun(accountId, contactId)) !== null) return;
    for (;;) {
      const queued = await tx.findOldestQueuedRun(accountId, contactId);
      if (queued === null) return;
      const known = await tx.getLeadFields(accountId, contactId);
      const { run } = await apply(tx, at, queued, { type: 'start', known });
      if (!isTerminal(run.status)) return;
    }
  }

  /**
   * getRun, lock its conversation, getRun again: the run may have moved on
   * while we waited for the lock. `at` is read once the lock is held.
   */
  function withLockedRun<T>(runId: string, fn: (tx: Tx, run: Run, at: Millis) => Promise<T>): Promise<T | null> {
    return store.tx(async (tx) => {
      const seen = await tx.getRun(runId);
      if (seen === null) return null;
      await tx.lockConversation(seen.accountId, seen.contactId);
      const run = await tx.getRun(runId);
      return run === null ? null : fn(tx, run, now());
    });
  }

  // -- outbox ---------------------------------------------------------------------

  /** Records the final outcome and tells the run, unless another worker settled the effect first. */
  async function settle(claimed: StoredEffect, outcome: Settlement): Promise<EffectOutcome> {
    const settled = await store.tx(async (tx) => {
      await tx.lockConversation(claimed.accountId, claimed.contactId);
      const current = await tx.getEffect(claimed.key);
      if (current?.status !== 'sending') return false;
      const at = now();
      await tx.updateEffect({
        ...current,
        status: outcome.status,
        leaseUntil: null,
        providerId: outcome.status === 'sent' ? outcome.providerId : current.providerId,
        lastError: outcome.status === 'sent' ? (outcome.note ?? current.lastError) : outcome.code,
        updatedAt: at,
      });
      // A run that has already ended (e.g. `run_ended`) ignores the event: the engine returns it unchanged.
      const run = await tx.getRun(current.runId);
      if (run !== null) {
        await dispatch(
          tx,
          at,
          run,
          outcome.status === 'sent'
            ? { type: 'effect_succeeded', key: current.key }
            : { type: 'effect_failed', key: current.key, code: outcome.code },
        );
      }
      return true;
    });
    return settled ? outcome.status : 'superseded';
  }

  /**
   * Back to `pending`. Fenced on `attempts`, which every claim increments: if
   * our lease lapsed and another worker reclaimed the row, the row is theirs.
   */
  async function reschedule(claimed: StoredEffect, retry: Retry): Promise<EffectOutcome> {
    return store.tx(async (tx) => {
      const at = now();
      // The platform told us about the account, whoever owns this row now.
      if (retry.throttleMs !== null) await tx.setAccountThrottle(claimed.accountId, at + retry.throttleMs);
      const current = await tx.getEffect(claimed.key);
      if (current?.status !== 'sending' || current.attempts !== claimed.attempts) return 'superseded';
      await tx.updateEffect({
        ...current,
        status: 'pending',
        attempts: retry.countAttempt ? current.attempts : current.attempts - 1,
        nextAttemptAt: retry.delayMs === null ? current.nextAttemptAt : at + retry.delayMs,
        leaseUntil: null,
        lastError: retry.lastError,
        updatedAt: at,
      });
      return 'retrying';
    });
  }

  async function deliver({ effect, wasInFlight }: ClaimedEffect, throttled: Set<string>): Promise<EffectOutcome> {
    // Unlocked read: a terminal status never changes, so "ended" cannot be stale.
    const run = await store.tx((tx) => tx.getRun(effect.runId));
    if (run === null || isTerminal(run.status)) return settle(effect, { status: 'failed', code: 'run_ended' });

    if (wasInFlight && effect.policy === 'at_most_once') {
      // A previous attempt may have reached the platform. A duplicate public
      // reply is worse than a missing one, so only a definite "not sent" sends.
      const seen = await adapter.reconcile(effect).catch(() => 'unknown' as const);
      if (seen === 'sent') return settle(effect, { status: 'sent', providerId: null, note: null });
      if (seen === 'unknown') {
        return settle(effect, { status: 'sent', providerId: null, note: 'unknown_outcome_assumed_sent' });
      }
    }

    if (throttled.has(effect.accountId)) {
      // Claimed in the same batch as an effect that just hit the account's rate
      // limit; sending would only hit it again. The throttle keeps it unclaimed.
      // Only after reconcile: back in `pending` it would lose its wasInFlight.
      const outcome = await reschedule(effect, {
        delayMs: null,
        lastError: effect.lastError,
        countAttempt: false,
        throttleMs: null,
      });
      return outcome === 'retrying' ? 'deferred' : outcome;
    }

    if (effect.attempts > config.maxEffectAttempts) {
      return settle(effect, { status: 'failed', code: 'retries_exhausted' });
    }

    let result: SendResult;
    try {
      result = await adapter.send(effect);
    } catch {
      // The platform may or may not have accepted it. at_most_once: leave the
      // row `sending`; when the lease lapses it is reclaimed with wasInFlight and
      // reconciled above. The others are safe (or required) to send again.
      if (effect.policy === 'at_most_once') return 'in_doubt';
      return reschedule(effect, {
        delayMs: config.backoffMs(effect.attempts),
        lastError: 'unknown_outcome',
        countAttempt: true,
        throttleMs: null,
      });
    }
    // Crash window: from here until settle/reschedule commits, the platform's
    // answer exists only in memory. A crash leaves the row `sending` until its
    // lease lapses, and the next claim treats it as in flight.

    if (result.ok) return settle(effect, { status: 'sent', providerId: result.providerId, note: null });
    const { error } = result;
    switch (error.kind) {
      case 'already_sent':
        // The platform deduplicated for us; this is why private replies are retry_safe.
        return settle(effect, { status: 'sent', providerId: null, note: null });
      case 'permanent':
        return settle(effect, { status: 'failed', code: error.code });
      case 'retryable': {
        const rateLimited = error.rateLimited === true;
        if (rateLimited) throttled.add(effect.accountId);
        return reschedule(effect, {
          delayMs: error.retryAfterMs ?? config.backoffMs(effect.attempts),
          lastError: error.code,
          // Being throttled is not the effect's fault.
          countAttempt: !rateLimited,
          throttleMs: rateLimited ? (error.retryAfterMs ?? config.defaultThrottleMs) : null,
        });
      }
    }
  }

  // -- public API -------------------------------------------------------------------

  return {
    async publishVersion(version) {
      const validation = validateDefinition(version.definition);
      if (!validation.ok) return { status: 'invalid', errors: validation.errors };
      await store.tx((tx) => tx.putVersion({ ...version, definition: validation.definition }));
      return { status: 'published' };
    },

    ingestComment(comment) {
      return store.tx(async (tx): Promise<CommentResult> => {
        if (!(await tx.recordInboundEvent(comment.eventId, now()))) return { status: 'duplicate' };
        const versions = (await tx.listEnabledVersions(comment.accountId))
          .filter((v) => matchesTrigger(v, comment))
          .sort((a, b) => (a.automationId < b.automationId ? -1 : a.automationId > b.automationId ? 1 : 0));
        if (versions.length === 0) return { status: 'no_match' };

        const contactId = comment.authorId;
        await tx.lockConversation(comment.accountId, contactId);
        const at = now();
        const triggers: TriggerResult[] = [];
        for (const version of versions) {
          const { automationId } = version;
          // Read first: a unique violation would kill a Postgres transaction.
          const existing = await tx.findRunByTrigger(automationId, comment.commentId);
          if (existing !== null) {
            triggers.push({ automationId, status: 'already_triggered', runId: existing.id });
            continue;
          }
          const since = at - version.cooldownSeconds * 1000;
          if (version.cooldownSeconds > 0 && (await tx.hasRunSince(automationId, contactId, since))) {
            triggers.push({ automationId, status: 'cooldown' });
            continue;
          }
          const run = newRun({ id: newId(), version, comment, now: at });
          await tx.insertRun(run);
          await tx.appendRunLog(run.id, at, `triggered by comment ${comment.commentId}`);
          triggers.push({ automationId, status: 'created', runId: run.id });
        }
        await promote(tx, at, comment.accountId, contactId);
        return { status: 'matched', triggers };
      });
    },

    async ingestMessage(message) {
      if (message.isEcho === true) return { status: 'echo' };
      return store.tx(async (tx): Promise<MessageResult> => {
        await tx.lockConversation(message.accountId, message.contactId);
        const at = now();
        const inserted = await tx.insertMessage({
          id: message.eventId,
          accountId: message.accountId,
          contactId: message.contactId,
          text: message.text,
          receivedAt: message.at,
          consumedByRunId: null,
        });
        if (!inserted) return { status: 'duplicate' };

        const run = await tx.findActiveRun(message.accountId, message.contactId);
        // A late webhook for a message sent before the run started is not an
        // answer to it: the same `startedAt` cut-off that drain applies.
        if (run === null || message.at < (run.startedAt ?? run.createdAt)) return { status: 'unmatched' };
        const result = await dispatch(tx, at, run, {
          type: 'message_received',
          messageId: message.eventId,
          text: message.text,
        });
        if (result.consumed) await tx.markMessageConsumed(message.eventId, run.id);
        return { status: 'delivered', runId: run.id, consumed: result.consumed };
      });
    },

    async cancelRun(runId, reason) {
      const result = await withLockedRun(runId, async (tx, run, at): Promise<CancelResult> => {
        if (isTerminal(run.status)) return { status: 'already_ended', runStatus: run.status };
        await dispatch(tx, at, run, { type: 'cancel', reason });
        return { status: 'cancelled' };
      });
      return result ?? { status: 'not_found' };
    },

    async tick() {
      const report: TickReport = {
        effects: { sent: 0, failed: 0, retrying: 0, deferred: 0, in_doubt: 0, superseded: 0 },
        timers: 0,
      };

      const claims = await store.tx((tx) => tx.claimDueEffects(now(), config.batchSize, config.leaseMs));
      const throttled = new Set<string>();
      // Sequential, and with no transaction open across the network call.
      for (const claim of claims) report.effects[await deliver(claim, throttled)]++;

      const due = await store.tx((tx) => tx.listDueTimers(now(), config.batchSize));
      for (const runId of due) {
        // If a reply won the race the run is no longer waiting and the engine ignores the timer.
        await withLockedRun(runId, (tx, run, at) => dispatch(tx, at, run, { type: 'timer_fired' }));
        report.timers++;
      }
      return report;
    },
  };
}

/** Calls `tick` until `signal` aborts, sleeping `intervalMs` only after a pass that found nothing to do. */
export async function runWorker(
  runtime: Runtime,
  { intervalMs, signal }: { intervalMs: Millis; signal: AbortSignal },
): Promise<void> {
  while (!signal.aborted) {
    if (!isIdle(await runtime.tick())) continue;
    await sleep(intervalMs, undefined, { signal }).catch(() => {}); // an abort ends the sleep early
  }
}
