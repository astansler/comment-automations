/**
 * Signatures of the pure core. Implemented in `engine.ts`; kept here so the
 * runtime and the engine can be built and reviewed independently.
 */
import type {
  AutomationDefinition,
  AutomationVersion,
  InboundComment,
  Millis,
  Run,
  RunEvent,
  TransitionResult,
} from './types.js';

/**
 * The whole behaviour of a run. Pure and total:
 * - never throws for any (run, event) pair, never performs I/O, never mutates `run`;
 * - an event that does not apply in the current state returns the run unchanged
 *   with `effect: null` and `consumed: false` (this is what makes duplicate and
 *   late deliveries harmless);
 * - emits at most one effect, and when it does the returned run is
 *   `awaiting_effect` with `pendingEffectKey` set to that effect's key.
 */
export type Transition = (
  definition: AutomationDefinition,
  run: Run,
  event: RunEvent,
  now: Millis,
) => TransitionResult;

/** Does this comment start this automation? Pure. Must reject the account's own comments. */
export type MatchesTrigger = (version: AutomationVersion, comment: InboundComment) => boolean;

export type ValidationResult =
  | { ok: true; definition: AutomationDefinition }
  | { ok: false; errors: string[] };

/**
 * Parse untrusted JSON into a definition and reject programs that cannot run
 * on the platform: only one private reply is allowed per comment, so on every
 * path through the steps (an `ask` with `skipIfKnown` may or may not run) at
 * most one DM may be sent before the contact is guaranteed to have replied.
 */
export type ValidateDefinition = (input: unknown) => ValidationResult;

/** First email address found in free text, lower-cased, or null. */
export type ExtractEmail = (text: string) => string | null;

/** Builds the initial `queued` run for a trigger. Pure. */
export type NewRun = (args: {
  id: string;
  version: AutomationVersion;
  comment: InboundComment;
  now: Millis;
}) => Run;
