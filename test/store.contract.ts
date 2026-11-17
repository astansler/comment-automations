/**
 * Behaviour every Store must have. Each test gets a fresh, empty store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AutomationVersion, Run } from '../src/core/types.js';
import { StoreConflictError } from '../src/store/errors.js';
import type { Store, StoredEffect, StoredMessage } from '../src/store/store.js';

export type MakeStore = () => Promise<{ store: Store; cleanup: () => Promise<void> }>;

const ACCOUNT = 'acct-1';
const CONTACT = 'contact-1';

export function aRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    versionId: 'ver-1',
    accountId: ACCOUNT,
    contactId: CONTACT,
    triggerCommentId: 'comment-1',
    status: 'queued',
    stepIndex: 0,
    attempt: 0,
    context: {},
    windowOpen: false,
    pendingEffectKey: null,
    wakeAt: null,
    outcome: null,
    createdAt: 1_000,
    startedAt: null,
    updatedAt: 1_000,
    ...overrides,
  };
}

export function aVersion(overrides: Partial<AutomationVersion> = {}): AutomationVersion {
  return {
    id: 'ver-1',
    automationId: 'auto-1',
    accountId: ACCOUNT,
    enabled: true,
    cooldownSeconds: 3600,
    definition: {
      trigger: { type: 'comment_keyword', platform: 'instagram', keywords: ['guide'], match: 'contains', postIds: 'any' },
      steps: [{ type: 'reply_to_comment', text: 'Check your DMs' }],
    },
    ...overrides,
  };
}

export function anEffect(overrides: Partial<StoredEffect> = {}): StoredEffect {
  return {
    key: 'run-1:0:0',
    runId: 'run-1',
    accountId: ACCOUNT,
    contactId: CONTACT,
    commentId: 'comment-1',
    kind: 'private_reply',
    policy: 'retry_safe',
    text: 'hello',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 1_000,
    leaseUntil: null,
    providerId: null,
    lastError: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

export function aMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'msg-1',
    accountId: ACCOUNT,
    contactId: CONTACT,
    text: 'me@example.com',
    receivedAt: 1_000,
    consumedByRunId: null,
    ...overrides,
  };
}

async function expectConflict(promise: Promise<unknown>, code: StoreConflictError['code']): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StoreConflictError);
  expect((err as StoreConflictError).code).toBe(code);
}

export function storeContract(name: string, makeStore: MakeStore): void {
  describe(`Store contract: ${name}`, () => {
    let store: Store;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ store, cleanup } = await makeStore());
    });
    afterEach(async () => {
      await cleanup();
    });

    describe('tx', () => {
      it('returns the value of fn and commits its writes', async () => {
        const value = await store.tx(async (tx) => {
          await tx.insertRun(aRun());
          return 42;
        });
        expect(value).toBe(42);
        expect(await store.tx((tx) => tx.getRun('run-1'))).toEqual(aRun());
      });

      it('rolls back every write and rethrows when fn throws', async () => {
        const boom = new Error('boom');
        await expect(
          store.tx(async (tx) => {
            await tx.recordInboundEvent('evt-1', 1);
            await tx.putVersion(aVersion());
            await tx.insertRun(aRun());
            await tx.insertMessage(aMessage());
            await tx.insertEffect(anEffect());
            await tx.setAccountThrottle(ACCOUNT, 5_000);
            await tx.upsertLead(ACCOUNT, CONTACT, 'email', 'a@b.co', 1);
            await tx.appendRunLog('run-1', 1, 'started');
            throw boom;
          }),
        ).rejects.toBe(boom);

        await store.tx(async (tx) => {
          expect(await tx.recordInboundEvent('evt-1', 2)).toBe(true);
          expect(await tx.getVersion('ver-1')).toBeNull();
          expect(await tx.getRun('run-1')).toBeNull();
          expect(await tx.listUnconsumedMessages(ACCOUNT, CONTACT, 0)).toEqual([]);
          expect(await tx.getEffect('run-1:0:0')).toBeNull();
          expect(await tx.getAccountThrottle(ACCOUNT)).toBeNull();
          expect(await tx.getLeadFields(ACCOUNT, CONTACT)).toEqual({});
          expect(await tx.listRunLog('run-1')).toEqual([]);
        });
      });

      it('rolls back an update to existing state', async () => {
        await store.tx((tx) => tx.insertRun(aRun()));
        await expect(
          store.tx(async (tx) => {
            await tx.updateRun(aRun({ status: 'running', updatedAt: 2_000 }));
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        expect(await store.tx((tx) => tx.getRun('run-1'))).toEqual(aRun());
      });
    });

    describe('recordInboundEvent', () => {
      it('returns true the first time and false for a redelivery', async () => {
        await store.tx(async (tx) => {
          expect(await tx.recordInboundEvent('evt-1', 1)).toBe(true);
          expect(await tx.recordInboundEvent('evt-1', 2)).toBe(false);
          expect(await tx.recordInboundEvent('evt-2', 2)).toBe(true);
        });
        expect(await store.tx((tx) => tx.recordInboundEvent('evt-1', 3))).toBe(false);
      });
    });

    describe('automation versions', () => {
      it('getVersion returns what putVersion stored, or null', async () => {
        await store.tx((tx) => tx.putVersion(aVersion()));
        await store.tx(async (tx) => {
          expect(await tx.getVersion('ver-1')).toEqual(aVersion());
          expect(await tx.getVersion('nope')).toBeNull();
        });
      });

      it('a repeated putVersion of the same id keeps the first row', async () => {
        await store.tx(async (tx) => {
          await tx.putVersion(aVersion());
          await tx.putVersion(aVersion({ enabled: false, cooldownSeconds: 1 }));
        });
        expect(await store.tx((tx) => tx.getVersion('ver-1'))).toEqual(aVersion());
      });

      it('listEnabledVersions returns the latest version of each automation of the account', async () => {
        await store.tx(async (tx) => {
          await tx.putVersion(aVersion({ id: 'b-1', automationId: 'auto-b' }));
          await tx.putVersion(aVersion({ id: 'a-1', automationId: 'auto-a' }));
          await tx.putVersion(aVersion({ id: 'a-2', automationId: 'auto-a', cooldownSeconds: 60 }));
          await tx.putVersion(aVersion({ id: 'other-1', automationId: 'auto-c', accountId: 'acct-2' }));
        });
        const versions = await store.tx((tx) => tx.listEnabledVersions(ACCOUNT));
        expect(versions.map((v) => v.id)).toEqual(['a-2', 'b-1']);
        expect(versions[0]).toEqual(aVersion({ id: 'a-2', automationId: 'auto-a', cooldownSeconds: 60 }));
      });

      it('latest is by publication order, not by id', async () => {
        await store.tx(async (tx) => {
          await tx.putVersion(aVersion({ id: 'z-first' }));
          await tx.putVersion(aVersion({ id: 'a-second' }));
        });
        const versions = await store.tx((tx) => tx.listEnabledVersions(ACCOUNT));
        expect(versions.map((v) => v.id)).toEqual(['a-second']);
      });

      it('a disabled latest version hides the automation even if an older one is enabled', async () => {
        await store.tx(async (tx) => {
          await tx.putVersion(aVersion({ id: 'v1', enabled: true }));
          await tx.putVersion(aVersion({ id: 'v2', enabled: false }));
        });
        expect(await store.tx((tx) => tx.listEnabledVersions(ACCOUNT))).toEqual([]);

        await store.tx((tx) => tx.putVersion(aVersion({ id: 'v3', enabled: true })));
        const versions = await store.tx((tx) => tx.listEnabledVersions(ACCOUNT));
        expect(versions.map((v) => v.id)).toEqual(['v3']);
      });

      it('returns copies', async () => {
        const v = aVersion();
        await store.tx((tx) => tx.putVersion(v));
        v.definition.trigger.keywords.push('mutated');
        const read = await store.tx((tx) => tx.getVersion('ver-1'));
        expect(read).toEqual(aVersion());
        read!.definition.steps.length = 0;
        expect(await store.tx((tx) => tx.getVersion('ver-1'))).toEqual(aVersion());
      });
    });

    describe('runs', () => {
      it('lockConversation can be called, also twice in one tx', async () => {
        await store.tx(async (tx) => {
          await tx.lockConversation(ACCOUNT, CONTACT);
          await tx.lockConversation(ACCOUNT, CONTACT);
          await tx.lockConversation(ACCOUNT, 'contact-2');
        });
      });

      it('getRun returns the stored run with every field, or null', async () => {
        const run = aRun({
          status: 'waiting_reply',
          stepIndex: 2,
          attempt: 1,
          context: { email: 'a@b.co' },
          windowOpen: true,
          pendingEffectKey: 'run-1:1:0',
          wakeAt: 1_700_000_000_123,
          outcome: 'x',
          startedAt: 1_500,
          updatedAt: 2_000,
        });
        await store.tx((tx) => tx.insertRun(run));
        await store.tx(async (tx) => {
          expect(await tx.getRun('run-1')).toEqual(run);
          expect(await tx.getRun('nope')).toBeNull();
        });
      });

      it('stores copies of runs passed in and returns copies', async () => {
        const run = aRun({ context: { a: '1' } });
        await store.tx((tx) => tx.insertRun(run));
        run.status = 'running';
        run.context.a = 'mutated';
        const read = await store.tx((tx) => tx.getRun('run-1'));
        expect(read).toEqual(aRun({ context: { a: '1' } }));
        read!.context.a = 'mutated';
        read!.stepIndex = 9;
        expect(await store.tx((tx) => tx.getRun('run-1'))).toEqual(aRun({ context: { a: '1' } }));
      });

      it('findRunByComment matches account and comment', async () => {
        await store.tx((tx) => tx.insertRun(aRun()));
        await store.tx(async (tx) => {
          expect(await tx.findRunByComment('acct-1', 'comment-1')).toEqual(aRun());
          expect(await tx.findRunByComment('acct-2', 'comment-1')).toBeNull();
          expect(await tx.findRunByComment('acct-1', 'comment-2')).toBeNull();
        });
      });

      it('findActiveRun returns only a run in an active status for that conversation', async () => {
        await store.tx(async (tx) => {
          await tx.insertRun(aRun({ id: 'queued', triggerCommentId: 'c1', status: 'queued' }));
          await tx.insertRun(aRun({ id: 'done', triggerCommentId: 'c2', status: 'completed' }));
          await tx.insertRun(aRun({ id: 'other', triggerCommentId: 'c3', status: 'running', contactId: 'contact-2' }));
        });
        expect(await store.tx((tx) => tx.findActiveRun(ACCOUNT, CONTACT))).toBeNull();

        for (const status of ['running', 'awaiting_effect', 'waiting_reply'] as const) {
          await store.tx((tx) => tx.updateRun(aRun({ id: 'queued', triggerCommentId: 'c1', status })));
          const active = await store.tx((tx) => tx.findActiveRun(ACCOUNT, CONTACT));
          expect(active?.id).toBe('queued');
          expect(active?.status).toBe(status);
        }
        expect((await store.tx((tx) => tx.findActiveRun(ACCOUNT, 'contact-2')))?.id).toBe('other');
        expect(await store.tx((tx) => tx.findActiveRun('acct-2', CONTACT))).toBeNull();
      });

      it('findOldestQueuedRun orders by createdAt, then id, within the conversation', async () => {
        await store.tx(async (tx) => {
          await tx.insertRun(aRun({ id: 'r-late', triggerCommentId: 'c1', createdAt: 3_000 }));
          await tx.insertRun(aRun({ id: 'r-b', triggerCommentId: 'c2', createdAt: 2_000 }));
          await tx.insertRun(aRun({ id: 'r-a', triggerCommentId: 'c3', createdAt: 2_000 }));
          await tx.insertRun(aRun({ id: 'r-0', triggerCommentId: 'c4', createdAt: 1_000, status: 'completed' }));
          await tx.insertRun(aRun({ id: 'r-x', triggerCommentId: 'c5', createdAt: 500, contactId: 'contact-2' }));
        });
        expect((await store.tx((tx) => tx.findOldestQueuedRun(ACCOUNT, CONTACT)))?.id).toBe('r-a');
        expect((await store.tx((tx) => tx.findOldestQueuedRun(ACCOUNT, 'contact-2')))?.id).toBe('r-x');
        expect(await store.tx((tx) => tx.findOldestQueuedRun(ACCOUNT, 'contact-3'))).toBeNull();
      });

      it('hasRunSince: same automation and contact, createdAt >= since', async () => {
        await store.tx((tx) => tx.insertRun(aRun({ createdAt: 5_000, status: 'completed' })));
        await store.tx(async (tx) => {
          expect(await tx.hasRunSince('auto-1', CONTACT, 4_999)).toBe(true);
          expect(await tx.hasRunSince('auto-1', CONTACT, 5_000)).toBe(true);
          expect(await tx.hasRunSince('auto-1', CONTACT, 5_001)).toBe(false);
          expect(await tx.hasRunSince('auto-2', CONTACT, 0)).toBe(false);
          expect(await tx.hasRunSince('auto-1', 'contact-2', 0)).toBe(false);
        });
      });

      it('insertRun rejects a second run for the same trigger comment with duplicate_trigger', async () => {
        await store.tx((tx) => tx.insertRun(aRun()));
        await expectConflict(store.tx((tx) => tx.insertRun(aRun({ id: 'run-2', contactId: 'contact-2' }))), 'duplicate_trigger');
        // Also for a different automation: a comment has one private reply to give.
        await expectConflict(
          store.tx((tx) => tx.insertRun(aRun({ id: 'run-3', automationId: 'auto-2', status: 'queued' }))),
          'duplicate_trigger',
        );
        // Comment ids are only unique within an account.
        await store.tx((tx) => tx.insertRun(aRun({ id: 'run-4', accountId: 'acct-2' })));
      });

      it('insertRun rejects a second active run in the conversation with conversation_busy', async () => {
        await store.tx((tx) => tx.insertRun(aRun({ status: 'awaiting_effect' })));
        await expectConflict(
          store.tx((tx) => tx.insertRun(aRun({ id: 'run-2', triggerCommentId: 'c2', status: 'running' }))),
          'conversation_busy',
        );
        // Queued runs, and active runs in other conversations, are fine.
        await store.tx(async (tx) => {
          await tx.insertRun(aRun({ id: 'run-3', triggerCommentId: 'c3', status: 'queued' }));
          await tx.insertRun(aRun({ id: 'run-4', triggerCommentId: 'c4', status: 'running', contactId: 'contact-2' }));
          await tx.insertRun(aRun({ id: 'run-5', triggerCommentId: 'c5', status: 'running', accountId: 'acct-2' }));
        });
      });

      it('a terminal run frees the conversation for the next active run', async () => {
        await store.tx((tx) => tx.insertRun(aRun({ status: 'waiting_reply' })));
        await store.tx((tx) => tx.updateRun(aRun({ status: 'completed', outcome: 'completed' })));
        await store.tx((tx) => tx.insertRun(aRun({ id: 'run-2', triggerCommentId: 'c2', status: 'running' })));
        expect((await store.tx((tx) => tx.findActiveRun(ACCOUNT, CONTACT)))?.id).toBe('run-2');
      });

      it('updateRun replaces the whole run', async () => {
        await store.tx((tx) => tx.insertRun(aRun({ context: { a: '1' } })));
        const next = aRun({ status: 'awaiting_effect', context: { b: '2' }, pendingEffectKey: 'k', startedAt: 2, updatedAt: 3 });
        await store.tx((tx) => tx.updateRun(next));
        expect(await store.tx((tx) => tx.getRun('run-1'))).toEqual(next);
      });

      it('updateRun rejects activating a second run in the conversation with conversation_busy', async () => {
        await store.tx(async (tx) => {
          await tx.insertRun(aRun({ status: 'running' }));
          await tx.insertRun(aRun({ id: 'run-2', triggerCommentId: 'c2', status: 'queued' }));
        });
        await expectConflict(
          store.tx((tx) => tx.updateRun(aRun({ id: 'run-2', triggerCommentId: 'c2', status: 'running' }))),
          'conversation_busy',
        );
        expect((await store.tx((tx) => tx.getRun('run-2')))?.status).toBe('queued');
        // Updating the owner itself is not a conflict.
        await store.tx((tx) => tx.updateRun(aRun({ status: 'waiting_reply' })));
      });

      it('listDueTimers: waiting_reply runs with wakeAt <= now, earliest deadline first, then id, limited', async () => {
        await store.tx(async (tx) => {
          const waiting = (id: string, wakeAt: number, contactId: string) =>
            tx.insertRun(aRun({ id, triggerCommentId: id, contactId, status: 'waiting_reply', wakeAt }));
          await waiting('t-late', 3_000, 'c1');
          await waiting('t-b', 2_000, 'c2');
          await waiting('t-a', 2_000, 'c3');
          await waiting('t-due-now', 4_000, 'c4');
          await waiting('t-future', 4_001, 'c5');
          // Has a wakeAt but is not waiting: never a timer.
          await tx.insertRun(aRun({ id: 'not-waiting', triggerCommentId: 'x', contactId: 'c6', status: 'awaiting_effect', wakeAt: 1 }));
          await tx.insertRun(aRun({ id: 'done', triggerCommentId: 'y', contactId: 'c7', status: 'expired', wakeAt: 1 }));
        });
        await store.tx(async (tx) => {
          expect(await tx.listDueTimers(4_000, 10)).toEqual(['t-a', 't-b', 't-late', 't-due-now']);
          expect(await tx.listDueTimers(4_000, 2)).toEqual(['t-a', 't-b']);
          expect(await tx.listDueTimers(1_999, 10)).toEqual([]);
        });
      });
    });

    describe('messages', () => {
      it('insertMessage returns false for an existing id and keeps the first', async () => {
        await store.tx(async (tx) => {
          expect(await tx.insertMessage(aMessage())).toBe(true);
          expect(await tx.insertMessage(aMessage({ text: 'second' }))).toBe(false);
        });
        expect(await store.tx((tx) => tx.listUnconsumedMessages(ACCOUNT, CONTACT, 0))).toEqual([aMessage()]);
      });

      it('listUnconsumedMessages filters by conversation, consumption and since (inclusive), oldest first', async () => {
        await store.tx(async (tx) => {
          await tx.insertMessage(aMessage({ id: 'm-late', receivedAt: 3_000 }));
          await tx.insertMessage(aMessage({ id: 'm-b', receivedAt: 2_000 }));
          await tx.insertMessage(aMessage({ id: 'm-a', receivedAt: 2_000 }));
          await tx.insertMessage(aMessage({ id: 'm-before', receivedAt: 1_999 }));
          await tx.insertMessage(aMessage({ id: 'm-consumed', receivedAt: 2_500 }));
          await tx.insertMessage(aMessage({ id: 'm-other-contact', receivedAt: 2_500, contactId: 'contact-2' }));
          await tx.insertMessage(aMessage({ id: 'm-other-account', receivedAt: 2_500, accountId: 'acct-2' }));
          await tx.markMessageConsumed('m-consumed', 'run-1');
        });
        const msgs = await store.tx((tx) => tx.listUnconsumedMessages(ACCOUNT, CONTACT, 2_000));
        expect(msgs.map((m) => m.id)).toEqual(['m-a', 'm-b', 'm-late']);
        expect(msgs[0]).toEqual(aMessage({ id: 'm-a', receivedAt: 2_000 }));
      });

      it('markMessageConsumed records the consuming run', async () => {
        await store.tx((tx) => tx.insertMessage(aMessage()));
        await store.tx((tx) => tx.markMessageConsumed('msg-1', 'run-9'));
        expect(await store.tx((tx) => tx.listUnconsumedMessages(ACCOUNT, CONTACT, 0))).toEqual([]);
        // A message stored as already consumed is never listed either.
        await store.tx((tx) => tx.insertMessage(aMessage({ id: 'msg-2', consumedByRunId: 'run-9' })));
        expect(await store.tx((tx) => tx.listUnconsumedMessages(ACCOUNT, CONTACT, 0))).toEqual([]);
      });

      it('returns copies', async () => {
        await store.tx((tx) => tx.insertMessage(aMessage()));
        const [read] = await store.tx((tx) => tx.listUnconsumedMessages(ACCOUNT, CONTACT, 0));
        read!.consumedByRunId = 'mutated';
        expect(await store.tx((tx) => tx.listUnconsumedMessages(ACCOUNT, CONTACT, 0))).toEqual([aMessage()]);
      });
    });

    describe('effects', () => {
      it('getEffect returns the stored effect with every field, or null', async () => {
        const e = anEffect({
          kind: 'direct_message',
          policy: 'at_least_once',
          status: 'sent',
          attempts: 2,
          leaseUntil: 9_000,
          providerId: 'p-1',
          lastError: 'timeout',
          updatedAt: 9_500,
        });
        await store.tx((tx) => tx.insertEffect(e));
        await store.tx(async (tx) => {
          expect(await tx.getEffect(e.key)).toEqual(e);
          expect(await tx.getEffect('nope')).toBeNull();
        });
      });

      it('a second insertEffect with the same key is a silent no-op that keeps the first row', async () => {
        await store.tx((tx) => tx.insertEffect(anEffect()));
        await store.tx((tx) => tx.insertEffect(anEffect({ text: 'second', status: 'sent' })));
        expect(await store.tx((tx) => tx.getEffect('run-1:0:0'))).toEqual(anEffect());
      });

      it('updateEffect replaces the whole effect', async () => {
        await store.tx((tx) => tx.insertEffect(anEffect()));
        const next = anEffect({ status: 'failed', attempts: 3, lastError: 'blocked', leaseUntil: 5, updatedAt: 6 });
        await store.tx((tx) => tx.updateEffect(next));
        expect(await store.tx((tx) => tx.getEffect('run-1:0:0'))).toEqual(next);
      });

      it('returns copies', async () => {
        const e = anEffect();
        await store.tx((tx) => tx.insertEffect(e));
        e.text = 'mutated';
        const read = await store.tx((tx) => tx.getEffect(e.key));
        read!.status = 'sent';
        expect(await store.tx((tx) => tx.getEffect(e.key))).toEqual(anEffect());
      });

      describe('claimDueEffects', () => {
        const NOW = 10_000;
        const LEASE = 30_000;

        it('claims due pending effects: sending, attempts + 1, leaseUntil = now + leaseMs', async () => {
          await store.tx(async (tx) => {
            await tx.insertEffect(anEffect({ key: 'due', nextAttemptAt: NOW, attempts: 1 }));
            await tx.insertEffect(anEffect({ key: 'not-due', nextAttemptAt: NOW + 1 }));
          });
          const claimed = await store.tx((tx) => tx.claimDueEffects(NOW, 10, LEASE));
          expect(claimed).toHaveLength(1);
          expect(claimed[0]!.wasInFlight).toBe(false);
          expect(claimed[0]!.effect).toMatchObject({ key: 'due', status: 'sending', attempts: 2, leaseUntil: NOW + LEASE });
          // The returned row is the row after the claim.
          expect(await store.tx((tx) => tx.getEffect('due'))).toEqual(claimed[0]!.effect);
          expect((await store.tx((tx) => tx.getEffect('not-due')))?.status).toBe('pending');
        });

        it('reclaims a sending effect whose lease expired, reporting wasInFlight', async () => {
          await store.tx(async (tx) => {
            await tx.insertEffect(anEffect({ key: 'expired', status: 'sending', attempts: 1, leaseUntil: NOW }));
            await tx.insertEffect(anEffect({ key: 'leased', status: 'sending', attempts: 1, leaseUntil: NOW + 1 }));
          });
          const claimed = await store.tx((tx) => tx.claimDueEffects(NOW, 10, LEASE));
          expect(claimed).toHaveLength(1);
          expect(claimed[0]!.wasInFlight).toBe(true);
          expect(claimed[0]!.effect).toMatchObject({ key: 'expired', status: 'sending', attempts: 2, leaseUntil: NOW + LEASE });
          expect(await store.tx((tx) => tx.getEffect('leased'))).toMatchObject({ attempts: 1, leaseUntil: NOW + 1 });
        });

        it('never claims sent or failed effects', async () => {
          await store.tx(async (tx) => {
            await tx.insertEffect(anEffect({ key: 'sent', status: 'sent', leaseUntil: 0 }));
            await tx.insertEffect(anEffect({ key: 'failed', status: 'failed', leaseUntil: 0 }));
          });
          expect(await store.tx((tx) => tx.claimDueEffects(NOW, 10, LEASE))).toEqual([]);
        });

        it('orders by nextAttemptAt, then key, and honours the limit', async () => {
          await store.tx(async (tx) => {
            await tx.insertEffect(anEffect({ key: 'k-3', nextAttemptAt: 3_000 }));
            await tx.insertEffect(anEffect({ key: 'k-b', nextAttemptAt: 2_000 }));
            await tx.insertEffect(anEffect({ key: 'k-a', nextAttemptAt: 2_000, status: 'sending', leaseUntil: 0 }));
            await tx.insertEffect(anEffect({ key: 'k-1', nextAttemptAt: 1_000 }));
          });
          const first = await store.tx((tx) => tx.claimDueEffects(NOW, 3, LEASE));
          expect(first.map((c) => c.effect.key)).toEqual(['k-1', 'k-a', 'k-b']);
          expect(first.map((c) => c.wasInFlight)).toEqual([false, true, false]);
          const rest = await store.tx((tx) => tx.claimDueEffects(NOW, 3, LEASE));
          expect(rest.map((c) => c.effect.key)).toEqual(['k-3']);
          expect(await store.tx((tx) => tx.claimDueEffects(NOW, 3, LEASE))).toEqual([]);
        });

        it('skips accounts throttled into the future, and claims them once the throttle has passed', async () => {
          await store.tx(async (tx) => {
            await tx.insertEffect(anEffect({ key: 'throttled', accountId: 'acct-slow' }));
            await tx.insertEffect(anEffect({ key: 'free', accountId: 'acct-fast' }));
            await tx.setAccountThrottle('acct-slow', NOW + 5_000);
          });
          const now = await store.tx((tx) => tx.claimDueEffects(NOW, 10, LEASE));
          expect(now.map((c) => c.effect.key)).toEqual(['free']);
          expect(await store.tx((tx) => tx.claimDueEffects(NOW + 4_999, 10, LEASE))).toEqual([]);
          const later = await store.tx((tx) => tx.claimDueEffects(NOW + 5_000, 10, LEASE));
          expect(later.map((c) => c.effect.key)).toEqual(['throttled']);
        });

        it('a claimed effect is not claimed again before its lease expires', async () => {
          await store.tx((tx) => tx.insertEffect(anEffect()));
          await store.tx((tx) => tx.claimDueEffects(NOW, 10, LEASE));
          expect(await store.tx((tx) => tx.claimDueEffects(NOW + LEASE - 1, 10, LEASE))).toEqual([]);
          const again = await store.tx((tx) => tx.claimDueEffects(NOW + LEASE, 10, LEASE));
          expect(again).toHaveLength(1);
          expect(again[0]).toMatchObject({ wasInFlight: true, effect: { attempts: 2, leaseUntil: NOW + 2 * LEASE } });
        });
      });
    });

    describe('account throttle', () => {
      it('is null until set, and never moves earlier', async () => {
        await store.tx(async (tx) => {
          expect(await tx.getAccountThrottle(ACCOUNT)).toBeNull();
          await tx.setAccountThrottle(ACCOUNT, 5_000);
          expect(await tx.getAccountThrottle(ACCOUNT)).toBe(5_000);
          await tx.setAccountThrottle(ACCOUNT, 4_000);
          expect(await tx.getAccountThrottle(ACCOUNT)).toBe(5_000);
          await tx.setAccountThrottle(ACCOUNT, 6_000);
          expect(await tx.getAccountThrottle(ACCOUNT)).toBe(6_000);
          expect(await tx.getAccountThrottle('acct-2')).toBeNull();
        });
      });
    });

    describe('leads', () => {
      it('upsertLead overwrites a field, and fields are per conversation', async () => {
        await store.tx(async (tx) => {
          expect(await tx.getLeadFields(ACCOUNT, CONTACT)).toEqual({});
          await tx.upsertLead(ACCOUNT, CONTACT, 'email', 'old@b.co', 1);
          await tx.upsertLead(ACCOUNT, CONTACT, 'name', 'Ann', 2);
          await tx.upsertLead(ACCOUNT, CONTACT, 'email', 'new@b.co', 3);
          await tx.upsertLead(ACCOUNT, 'contact-2', 'email', 'other@b.co', 4);
          await tx.upsertLead('acct-2', CONTACT, 'email', 'acct2@b.co', 5);
        });
        await store.tx(async (tx) => {
          expect(await tx.getLeadFields(ACCOUNT, CONTACT)).toEqual({ email: 'new@b.co', name: 'Ann' });
          expect(await tx.getLeadFields(ACCOUNT, 'contact-2')).toEqual({ email: 'other@b.co' });
          expect(await tx.getLeadFields('acct-2', CONTACT)).toEqual({ email: 'acct2@b.co' });
        });
      });
    });

    describe('run log', () => {
      it('lists a run’s entries in the order they were appended', async () => {
        await store.tx(async (tx) => {
          await tx.appendRunLog('run-1', 2_000, 'first');
          await tx.appendRunLog('run-2', 1_000, 'other run');
          await tx.appendRunLog('run-1', 1_000, 'second, earlier clock');
        });
        await store.tx((tx) => tx.appendRunLog('run-1', 2_000, 'third'));
        expect(await store.tx((tx) => tx.listRunLog('run-1'))).toEqual([
          { runId: 'run-1', at: 2_000, entry: 'first' },
          { runId: 'run-1', at: 1_000, entry: 'second, earlier clock' },
          { runId: 'run-1', at: 2_000, entry: 'third' },
        ]);
        expect(await store.tx((tx) => tx.listRunLog('run-3'))).toEqual([]);
      });
    });
  });
}
