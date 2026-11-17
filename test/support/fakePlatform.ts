/**
 * Test doubles for the runtime's outside world. The fake platform enforces the
 * platform rules the design depends on (one private reply per comment, no DM
 * before the contact has written to us), so a test that passes proves the
 * runtime respects them rather than assuming it.
 */
import type { EffectKind, Millis } from '../../src/core/types.js';
import type { PlatformAdapter, SendResult } from '../../src/runtime/adapter.js';
import type { StoredEffect } from '../../src/store/store.js';

/** A send that reached the platform. */
export interface Delivery {
  key: string;
  kind: EffectKind;
  accountId: string;
  contactId: string;
  commentId: string;
  text: string;
}

export type Fault =
  | { type: 'retryable'; code: string }
  | { type: 'rate_limited'; retryAfterMs: Millis | undefined }
  | { type: 'permanent'; code: string }
  /** Rejects; nothing reaches the platform. */
  | { type: 'throw_before' }
  /** Delivers, then rejects: we crashed after the platform accepted. */
  | { type: 'throw_after' };

export const fault = {
  retryable: (code = 'server_error'): Fault => ({ type: 'retryable', code }),
  rateLimited: (retryAfterMs?: Millis): Fault => ({ type: 'rate_limited', retryAfterMs }),
  permanent: (code: string): Fault => ({ type: 'permanent', code }),
  throwBefore: (): Fault => ({ type: 'throw_before' }),
  throwAfter: (): Fault => ({ type: 'throw_after' }),
};

export interface FakePlatform extends PlatformAdapter {
  /** What reached the platform, in order. */
  readonly deliveries: readonly Delivery[];
  /** Effect keys passed to `send`, in order, whether or not they got through. */
  readonly sendCalls: readonly string[];
  /** Effect keys passed to `reconcile`, in order. */
  readonly reconcileCalls: readonly string[];
  /** The contact wrote to the account, which opens the DM window. */
  contactMessaged(accountId: string, contactId: string): void;
  /** Faults for the next sends matching `target`, consumed in order. Key faults are used before kind faults. */
  inject(target: { key: string } | { kind: EffectKind }, ...faults: Fault[]): void;
  reconcileAnswers(mode: 'truthfully' | 'unknown'): void;
  /** Runs after a delivery reaches the platform and before `send` returns: the contact can already react. */
  onDelivered(listener: (delivery: Delivery) => Promise<void>): void;
}

export function createFakePlatform(): FakePlatform {
  const deliveries: Delivery[] = [];
  const sendCalls: string[] = [];
  const reconcileCalls: string[] = [];
  const openWindows = new Set<string>();
  const byKey = new Map<string, Fault[]>();
  const byKind = new Map<EffectKind, Fault[]>();
  let reconcileMode: 'truthfully' | 'unknown' = 'truthfully';
  let listener: ((delivery: Delivery) => Promise<void>) | null = null;

  const conversation = (accountId: string, contactId: string): string => JSON.stringify([accountId, contactId]);
  const failed = (error: Extract<SendResult, { ok: false }>['error']): SendResult => ({ ok: false, error });

  return {
    deliveries,
    sendCalls,
    reconcileCalls,

    contactMessaged(accountId, contactId) {
      openWindows.add(conversation(accountId, contactId));
    },

    inject(target, ...faults) {
      if ('key' in target) byKey.set(target.key, [...(byKey.get(target.key) ?? []), ...faults]);
      else byKind.set(target.kind, [...(byKind.get(target.kind) ?? []), ...faults]);
    },

    reconcileAnswers(mode) {
      reconcileMode = mode;
    },

    onDelivered(fn) {
      listener = fn;
    },

    async send(effect: StoredEffect) {
      sendCalls.push(effect.key);
      const f = byKey.get(effect.key)?.shift() ?? byKind.get(effect.kind)?.shift();
      switch (f?.type) {
        case 'throw_before':
          throw new Error('network error before the request reached the platform');
        case 'retryable':
          return failed({ kind: 'retryable', code: f.code });
        case 'rate_limited':
          return failed({
            kind: 'retryable',
            code: 'rate_limited',
            rateLimited: true,
            ...(f.retryAfterMs === undefined ? {} : { retryAfterMs: f.retryAfterMs }),
          });
        case 'permanent':
          return failed({ kind: 'permanent', code: f.code });
      }

      if (
        effect.kind === 'private_reply' &&
        deliveries.some((d) => d.kind === 'private_reply' && d.commentId === effect.commentId)
      ) {
        return failed({ kind: 'already_sent' });
      }
      if (effect.kind === 'direct_message' && !openWindows.has(conversation(effect.accountId, effect.contactId))) {
        return failed({ kind: 'permanent', code: 'window_closed' });
      }

      const delivery: Delivery = {
        key: effect.key,
        kind: effect.kind,
        accountId: effect.accountId,
        contactId: effect.contactId,
        commentId: effect.commentId,
        text: effect.text,
      };
      deliveries.push(delivery);
      await listener?.(delivery);
      if (f?.type === 'throw_after') throw new Error('connection lost after the platform accepted the request');
      return { ok: true, providerId: `provider-${deliveries.length}` };
    },

    async reconcile(effect: StoredEffect) {
      reconcileCalls.push(effect.key);
      if (reconcileMode === 'unknown') return 'unknown';
      return deliveries.some((d) => d.key === effect.key) ? 'sent' : 'not_sent';
    },
  };
}

export function createClock(start: Millis): { now: () => Millis; advance: (ms: Millis) => void; set: (at: Millis) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (at) => {
      t = at;
    },
  };
}

/** `prefix-0001`, `prefix-0002`, ...: zero-padded so id order is creation order. */
export function createIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(4, '0')}`;
}
