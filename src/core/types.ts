/**
 * Core vocabulary. Everything here is plain serialisable data: no classes, no
 * Dates (timestamps are epoch milliseconds), no I/O. The engine is a pure
 * function over these types; stores and the runtime only move them around.
 */

export type Millis = number;

export type Platform = 'instagram';

// ---------------------------------------------------------------------------
// Automation definition: the document a customer (or an agent over the API)
// authors. Immutable once published; runs pin the version they started on.
// ---------------------------------------------------------------------------

export interface CommentKeywordTrigger {
  type: 'comment_keyword';
  platform: Platform;
  /** Non-empty. Matching is case-insensitive on normalised text. */
  keywords: string[];
  /** `contains`: keyword appears as a whole word. `exact`: comment is the keyword. */
  match: 'contains' | 'exact';
  /** `'any'` or an explicit list of post ids. */
  postIds: 'any' | string[];
}

/** Publicly reply to the triggering comment. */
export interface ReplyToCommentStep {
  type: 'reply_to_comment';
  text: string;
}

/**
 * Send a DM to the commenter. `text` may reference captured fields as
 * `{{name}}`. The engine decides how it is addressed: as a *private reply*
 * (addressed by comment id, one allowed per comment) while the contact has not
 * messaged us, as an ordinary direct message afterwards.
 */
export interface SendDmStep {
  type: 'send_dm';
  text: string;
}

/**
 * Ask the contact a question by DM and pause until they answer.
 *
 * The prompt and the wait are one step on purpose: a wait with no question has
 * nothing to correlate a reply with, and keeping them together means
 * `skipIfKnown` skips the question too, not just the waiting.
 */
export interface AskStep {
  type: 'ask';
  /** The question. Sent like a `send_dm`. May use `{{name}}` templates. */
  prompt: string;
  /** `email`: extract an address from the reply. `any`: any non-empty reply answers. */
  capture: 'email' | 'any';
  /** Context / lead field the captured value is stored under. */
  saveAs: string;
  /** Deadline measured from the moment the prompt is delivered. Not extended by reprompts. */
  timeoutSeconds: number;
  /** How many inbound messages we will examine before giving up (>= 1). */
  maxAttempts: number;
  /** Sent when a reply has nothing to capture and attempts remain. */
  repromptText: string;
  /** Skip the whole step if this contact already gave us the field. */
  skipIfKnown?: boolean;
}

export type Step = ReplyToCommentStep | SendDmStep | AskStep;

export interface AutomationDefinition {
  trigger: CommentKeywordTrigger;
  steps: Step[];
}

/** A published, immutable version of an automation. */
export interface AutomationVersion {
  id: string;
  automationId: string;
  accountId: string;
  enabled: boolean;
  /** Same contact cannot re-trigger the same automation within this window. */
  cooldownSeconds: number;
  definition: AutomationDefinition;
}

// ---------------------------------------------------------------------------
// Run: one execution of one automation version for one commenter.
// ---------------------------------------------------------------------------

export type RunStatus =
  /** Created, but another run owns the conversation with this contact. */
  | 'queued'
  /** Transient: between steps inside a transition. Never persisted at rest. */
  | 'running'
  /** One outbound effect is in the outbox; the run resumes on its result. */
  | 'awaiting_effect'
  /** Parked until the contact replies or `wakeAt` passes. */
  | 'waiting_reply'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

/** Statuses that own the (account, contact) conversation. At most one run per conversation. */
export const ACTIVE_STATUSES = ['running', 'awaiting_effect', 'waiting_reply'] as const;
export const TERMINAL_STATUSES = ['completed', 'failed', 'expired', 'cancelled'] as const;

export const isActive = (s: RunStatus): boolean => (ACTIVE_STATUSES as readonly string[]).includes(s);
export const isTerminal = (s: RunStatus): boolean => (TERMINAL_STATUSES as readonly string[]).includes(s);

export interface Run {
  id: string;
  automationId: string;
  versionId: string;
  accountId: string;
  /** Platform-scoped id of the commenter. Immutable. */
  contactId: string;
  /** The comment that started the run. Immutable. */
  triggerCommentId: string;
  status: RunStatus;
  /** Index of the step currently executing or waiting. `steps.length` once done. */
  stepIndex: number;
  /** Inbound messages examined by the current `ask` step. Reset when the step advances. */
  attempt: number;
  /** Captured fields, e.g. `{ email: "a@b.co" }`. */
  context: Record<string, string>;
  /** The contact has messaged us since the run became active, so ordinary DMs are allowed. */
  windowOpen: boolean;
  /** Key of the effect the run is waiting on, when `awaiting_effect`. */
  pendingEffectKey: string | null;
  /** Deadline of the current `ask`. Set when its prompt is delivered, cleared when the step ends. */
  wakeAt: Millis | null;
  /** Why the run ended, e.g. `completed`, `timeout`, `no_valid_reply`, `effect_failed:<code>`. */
  outcome: string | null;
  createdAt: Millis;
  /** When the run became active (left `queued`). Messages before this are not answers to it. */
  startedAt: Millis | null;
  updatedAt: Millis;
}

// ---------------------------------------------------------------------------
// Events in, effects out.
// ---------------------------------------------------------------------------

export type RunEvent =
  /** Run takes ownership of the conversation. `known` = lead fields we already hold for the contact. */
  | { type: 'start'; known: Record<string, string> }
  /** The outbox delivered the effect (or decided it must be treated as delivered). */
  | { type: 'effect_succeeded'; key: string }
  /** The outbox gave up on the effect: permanent error or retries exhausted. */
  | { type: 'effect_failed'; key: string; code: string }
  /**
   * `beforePrompt`: the message was written before the current question was
   * delivered (replayed from storage, or a late webhook). It answers the question only if
   * it plainly is the answer; otherwise the run leaves it alone.
   */
  | { type: 'message_received'; messageId: string; text: string; beforePrompt?: boolean }
  | { type: 'timer_fired' }
  | { type: 'cancel'; reason: string };

export type EffectKind = 'reply_to_comment' | 'private_reply' | 'direct_message';

/**
 * What to do when we do not know whether a send reached the platform
 * (timeout, or a crash between the API call and recording its result).
 *
 * - `retry_safe`: the platform itself deduplicates (one private reply per
 *   comment), so we retry and read "already sent" as success.
 * - `at_most_once`: a duplicate is worse than a miss (a second public reply).
 *   Never blindly retried; reconciled, and if still unknown, treated as sent.
 * - `at_least_once`: a miss is worse than a duplicate (the DM carrying the
 *   link). Retried.
 */
export type DeliveryPolicy = 'retry_safe' | 'at_most_once' | 'at_least_once';

export const DELIVERY_POLICY: Record<EffectKind, DeliveryPolicy> = {
  private_reply: 'retry_safe',
  reply_to_comment: 'at_most_once',
  direct_message: 'at_least_once',
};

/**
 * Kinds the outbox sends before the others. An ordinary DM only exists inside
 * a conversation the contact has already answered, and it has a deadline the
 * others do not have: the platform's 24-hour window, counted from the contact's
 * last message. A first message to a new commenter can wait days; this cannot.
 */
export const SENT_FIRST: readonly EffectKind[] = ['direct_message'];

/** What the engine asks the outside world to do. At most one per transition. */
export interface EffectRequest {
  /** Deterministic idempotency key: `${runId}:${stepIndex}:${attempt}` (attempt 0 = the step's first send, n = nth reprompt). */
  key: string;
  kind: EffectKind;
  /** Final text, templates already rendered. */
  text: string;
}

export interface TransitionResult {
  run: Run;
  /** The single outbound effect to enqueue, if any. */
  effect: EffectRequest | null;
  /** For `message_received`: whether this run used the message up. */
  consumed: boolean;
  /** A field captured in this transition, to be persisted as a lead. */
  captured: { field: string; value: string } | null;
  /** Human-readable trace lines for the run log. */
  log: string[];
}

// ---------------------------------------------------------------------------
// Inbound facts, as delivered by the (assumed existing) ingestion layer.
// ---------------------------------------------------------------------------

export interface InboundComment {
  /** Platform's id for this webhook event. Used to drop redeliveries. */
  eventId: string;
  accountId: string;
  commentId: string;
  postId: string;
  /** Platform-scoped id of the author. Equal to `accountId` for our own comments. */
  authorId: string;
  text: string;
  at: Millis;
}

export interface InboundMessageEvent {
  /** Platform's message id. Used to drop redeliveries. */
  eventId: string;
  accountId: string;
  /** Platform-scoped id of the other party in the conversation. */
  contactId: string;
  text: string;
  at: Millis;
  /** True for webhooks that echo a message we sent ourselves. */
  isEcho?: boolean;
}
