/**
 * The seam to the social platform. The brief says sending already exists, so
 * this is only the shape the automation runtime needs from it.
 */
import type { StoredEffect } from '../store/store.js';

export type SendResult =
  | { ok: true; providerId: string }
  | {
      ok: false;
      error:
        /** Try again later. `rateLimited` throttles the whole account until `retryAfterMs`. */
        | { kind: 'retryable'; code: string; retryAfterMs?: number; rateLimited?: boolean }
        /** Never going to work: user blocked DMs, comment deleted, token revoked. */
        | { kind: 'permanent'; code: string }
        /** The platform says this exact send already happened (second private reply to a comment). */
        | { kind: 'already_sent' };
    };

export interface PlatformAdapter {
  /**
   * Perform the send. May also reject (network error, timeout): in that case
   * the outcome is unknown and the runtime applies the effect's delivery policy.
   */
  send(effect: StoredEffect): Promise<SendResult>;
  /**
   * Best-effort check of whether an effect with an unknown outcome reached the
   * platform (echo webhooks, or listing recent replies / messages).
   */
  reconcile(effect: StoredEffect): Promise<'sent' | 'not_sent' | 'unknown'>;
}
