/**
 * Persistence contract. Two implementations: in-memory (tests, simulation) and
 * Postgres (the real one). Both must pass `test/store.contract.ts`.
 *
 * Concurrency model, in one sentence: **the conversation is the lock.**
 * Every mutation of a run happens inside a transaction that first calls
 * `lockConversation(run.accountId, run.contactId)`. A run belongs to exactly
 * one conversation for its whole life, so that single lock serialises
 * triggers, inbound messages, effect results and timers for the run. Unique
 * indexes back the invariants up; they are not the mechanism.
 */
import type { AutomationVersion, DeliveryPolicy, EffectKind, Millis, Run } from '../core/types.js';

export type EffectStatus =
  /** Waiting for `nextAttemptAt`. */
  | 'pending'
  /** Claimed by a worker until `leaseUntil`; the API call may be in flight. */
  | 'sending'
  | 'sent'
  | 'failed';

export interface StoredEffect {
  /** Idempotency key from the engine. Primary key. */
  key: string;
  runId: string;
  accountId: string;
  contactId: string;
  commentId: string;
  kind: EffectKind;
  policy: DeliveryPolicy;
  text: string;
  status: EffectStatus;
  /** Number of times a worker has claimed it. */
  attempts: number;
  nextAttemptAt: Millis;
  leaseUntil: Millis | null;
  providerId: string | null;
  lastError: string | null;
  createdAt: Millis;
  updatedAt: Millis;
}

export interface ClaimedEffect {
  effect: StoredEffect;
  /**
   * True when the row was already `sending` and its lease had expired: a
   * previous worker may or may not have reached the platform. The runtime uses
   * this to apply the effect's delivery policy.
   */
  wasInFlight: boolean;
}

export interface StoredMessage {
  /** Platform message id. Primary key. */
  id: string;
  accountId: string;
  contactId: string;
  text: string;
  receivedAt: Millis;
  consumedByRunId: string | null;
}

export interface RunLogEntry {
  runId: string;
  at: Millis;
  entry: string;
}

export interface Tx {
  // -- inbox -----------------------------------------------------------------
  /** Records a webhook event id. Returns false if it was already recorded. */
  recordInboundEvent(eventId: string, at: Millis): Promise<boolean>;

  // -- automations -----------------------------------------------------------
  putVersion(version: AutomationVersion): Promise<void>;
  getVersion(versionId: string): Promise<AutomationVersion | null>;
  /** Current enabled versions for an account (latest version per automation). */
  listEnabledVersions(accountId: string): Promise<AutomationVersion[]>;

  // -- runs ------------------------------------------------------------------
  /**
   * Exclusive lock on the (account, contact) conversation, held until the
   * transaction ends. Blocks while another transaction holds it.
   */
  lockConversation(accountId: string, contactId: string): Promise<void>;
  getRun(runId: string): Promise<Run | null>;
  findRunByTrigger(automationId: string, commentId: string): Promise<Run | null>;
  /** The run that owns the conversation: status in ACTIVE_STATUSES. */
  findActiveRun(accountId: string, contactId: string): Promise<Run | null>;
  /** Oldest `queued` run for the conversation, by createdAt then id. */
  findOldestQueuedRun(accountId: string, contactId: string): Promise<Run | null>;
  /** Any run of this automation for this contact created at or after `since`. */
  hasRunSince(automationId: string, contactId: string, since: Millis): Promise<boolean>;
  /**
   * Throws if it would violate either invariant:
   * unique (automationId, triggerCommentId), or one active run per conversation.
   */
  insertRun(run: Run): Promise<void>;
  /** Full replace by id. Throws if it would create a second active run for the conversation. */
  updateRun(run: Run): Promise<void>;
  /** Ids of `waiting_reply` runs with `wakeAt <= now`, oldest deadline first. */
  listDueTimers(now: Millis, limit: number): Promise<string[]>;

  // -- messages --------------------------------------------------------------
  /** Returns false if a message with this id already exists. */
  insertMessage(message: StoredMessage): Promise<boolean>;
  /** Unconsumed messages in the conversation with `receivedAt >= since`, oldest first. */
  listUnconsumedMessages(accountId: string, contactId: string, since: Millis): Promise<StoredMessage[]>;
  markMessageConsumed(messageId: string, runId: string): Promise<void>;

  // -- effects (outbox) --------------------------------------------------------
  /** Insert; a second insert with the same key is a silent no-op. */
  insertEffect(effect: StoredEffect): Promise<void>;
  getEffect(key: string): Promise<StoredEffect | null>;
  updateEffect(effect: StoredEffect): Promise<void>;
  /**
   * Atomically claim up to `limit` effects that are due:
   *   (`pending` and `nextAttemptAt <= now`) or (`sending` and `leaseUntil <= now`),
   * skipping accounts whose throttle is in the future and rows locked by other
   * claimers (SKIP LOCKED). Claimed rows become `sending`, `attempts + 1`,
   * `leaseUntil = now + leaseMs`. Ordered by `nextAttemptAt`, then key.
   * The returned effects reflect the row *after* the claim.
   */
  claimDueEffects(now: Millis, limit: number, leaseMs: Millis): Promise<ClaimedEffect[]>;

  // -- account throttle --------------------------------------------------------
  /** No effect of this account is claimed before `until`. Never moves the throttle earlier. */
  setAccountThrottle(accountId: string, until: Millis): Promise<void>;
  getAccountThrottle(accountId: string): Promise<Millis | null>;

  // -- leads and log -----------------------------------------------------------
  upsertLead(accountId: string, contactId: string, field: string, value: string, at: Millis): Promise<void>;
  getLeadFields(accountId: string, contactId: string): Promise<Record<string, string>>;
  appendRunLog(runId: string, at: Millis, entry: string): Promise<void>;
  listRunLog(runId: string): Promise<RunLogEntry[]>;
}

export interface Store {
  /**
   * Run `fn` in one transaction. Commits if it resolves, rolls back everything
   * if it throws (and rethrows).
   */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
