/**
 * End-to-end behaviour of the runtime over a real store and a fake platform
 * that enforces the platform's rules. Each scenario checks both the run and
 * what actually reached the platform. Each test gets a fresh, empty store.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateDefinition } from '../src/core/engine.js';
import type { AutomationDefinition, Run } from '../src/core/types.js';
import {
  createRuntime,
  isIdle,
  type CommentResult,
  type MessageResult,
  type RuntimeConfig,
  type TickReport,
  type VersionInput,
} from '../src/runtime/runtime.js';
import type { Store, StoredEffect } from '../src/store/store.js';
import type { MakeStore } from './store.contract.js';
import { createClock, createFakePlatform, createIds, fault } from './support/fakePlatform.js';
import { CrashError, createFaultyStore } from './support/faultyStore.js';

const loaded = validateDefinition(JSON.parse(readFileSync(new URL('../examples/pricing.json', import.meta.url), 'utf8')));
if (!loaded.ok) throw new Error(`examples/pricing.json is invalid: ${loaded.errors.join('; ')}`);
const PRICING: AutomationDefinition = loaded.definition;

const TEXT = {
  reply: 'Sent you a DM!',
  prompt: "Happy to share pricing. What's the best email to send it to?",
  reprompt: "I couldn't spot an email address in that. Could you send it again?",
  link: 'Thanks! Here is the link: https://example.com/pricing',
  demoPrompt: 'Want a demo? What is your email?',
  demoLink: 'Book your demo: https://example.com/demo',
};

const DEMO: AutomationDefinition = {
  trigger: { ...PRICING.trigger, keywords: ['demo'] },
  steps: [
    {
      type: 'ask',
      prompt: TEXT.demoPrompt,
      capture: 'email',
      saveAs: 'email',
      timeoutSeconds: 3600,
      maxAttempts: 2,
      repromptText: 'That did not look like an email. Try again?',
      skipIfKnown: true,
    },
    { type: 'send_dm', text: TEXT.demoLink },
  ],
};

const T0 = 1_750_000_000_000;
const TIMEOUT_MS = 82_800 * 1000;
const LEASE_MS = 60_000;
const ACCOUNT = 'acct-1';
const OTHER_ACCOUNT = 'acct-2';
const ALICE = 'alice';

export function runtimeScenarios(name: string, makeStore: MakeStore): void {
  describe(`Runtime scenarios: ${name}`, () => {
    let store: Store;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ store, cleanup } = await makeStore());
    });
    afterEach(async () => {
      await cleanup();
    });

    function setup(config: Partial<RuntimeConfig> = {}) {
      const clock = createClock(T0);
      const platform = createFakePlatform();
      const runtime = createRuntime({ store, adapter: platform, now: clock.now, newId: createIds('run'), config });
      let seq = 0;

      return {
        clock,
        platform,
        runtime,

        async publish(overrides: Partial<VersionInput> = {}): Promise<void> {
          const version: VersionInput = {
            id: 'pricing-v1',
            automationId: 'pricing',
            accountId: ACCOUNT,
            enabled: true,
            cooldownSeconds: 0,
            definition: PRICING,
            ...overrides,
          };
          expect(await runtime.publishVersion(version)).toEqual({ status: 'published' });
        },

        comment(
          text: string,
          opts: { from?: string; commentId?: string; eventId?: string; accountId?: string } = {},
        ): Promise<CommentResult> {
          seq++;
          const commentId = opts.commentId ?? `comment-${seq}`;
          return runtime.ingestComment({
            eventId: opts.eventId ?? `comment-event-${seq}`,
            accountId: opts.accountId ?? ACCOUNT,
            commentId,
            postId: 'post-1',
            authorId: opts.from ?? ALICE,
            text,
            at: clock.now(),
          });
        },

        /** The contact writes to us: opens the platform's DM window and delivers the webhook. */
        message(text: string, opts: { from?: string; eventId?: string } = {}): Promise<MessageResult> {
          const contactId = opts.from ?? ALICE;
          platform.contactMessaged(ACCOUNT, contactId);
          return runtime.ingestMessage({
            eventId: opts.eventId ?? `message-${++seq}`,
            accountId: ACCOUNT,
            contactId,
            text,
            at: clock.now(),
          });
        },

        tick: (): Promise<TickReport> => runtime.tick(),

        /** Ticks until a pass finds nothing due at the current (frozen) time. */
        async runUntilIdle(): Promise<void> {
          for (let i = 0; i < 50; i++) if (isIdle(await runtime.tick())) return;
          throw new Error('worker still busy after 50 ticks');
        },

        async run(id: string): Promise<Run> {
          const run = await store.tx((tx) => tx.getRun(id));
          if (run === null) throw new Error(`run ${id} not found`);
          return run;
        },

        async effect(key: string): Promise<StoredEffect> {
          const effect = await store.tx((tx) => tx.getEffect(key));
          if (effect === null) throw new Error(`effect ${key} not found`);
          return effect;
        },

        log: async (runId: string): Promise<string[]> =>
          (await store.tx((tx) => tx.listRunLog(runId))).map((e) => e.entry),

        /** What reached the platform, as `kind: text`. */
        sent: (): string[] => platform.deliveries.map((d) => `${d.kind}: ${d.text}`),

        /** Publishes pricing, alice comments, the worker delivers reply and prompt: run-0001 waits for her email. */
        async untilWaiting(): Promise<string> {
          await this.publish();
          await this.comment('pricing?');
          await this.runUntilIdle();
          expect(await this.run('run-0001')).toMatchObject({ status: 'waiting_reply', wakeAt: clock.now() + TIMEOUT_MS });
          return 'run-0001';
        },
      };
    }

    const unconsumed = (contactId: string) =>
      store.tx((tx) => tx.listUnconsumedMessages(ACCOUNT, contactId, 0));

    it('runs the brief end to end: public reply, email prompt, captured email, link by DM', async () => {
      const h = setup();
      await h.publish();

      expect(await h.comment('What is the pricing?')).toEqual({
        status: 'matched',
        triggers: [{ automationId: 'pricing', status: 'created', runId: 'run-0001' }],
      });
      await h.runUntilIdle();
      expect(await h.run('run-0001')).toMatchObject({ status: 'waiting_reply', wakeAt: T0 + TIMEOUT_MS });

      h.clock.advance(60_000);
      expect(await h.message('sure: Alice@Example.com')).toEqual({ status: 'delivered', runId: 'run-0001', consumed: true });
      await h.runUntilIdle();

      expect(await h.run('run-0001')).toMatchObject({
        status: 'completed',
        outcome: 'completed',
        context: { email: 'alice@example.com' },
      });
      expect(h.sent()).toEqual([
        `reply_to_comment: ${TEXT.reply}`,
        `private_reply: ${TEXT.prompt}`,
        `direct_message: ${TEXT.link}`,
      ]);
      expect(h.platform.deliveries.map((d) => d.commentId)).toEqual(['comment-1', 'comment-1', 'comment-1']);
      expect(await store.tx((tx) => tx.getLeadFields(ACCOUNT, ALICE))).toEqual({ email: 'alice@example.com' });
      expect(await h.log('run-0001')).toEqual([
        'triggered by comment comment-1',
        'started',
        'step 0 reply_to_comment: reply sent',
        'step 0 reply_to_comment: delivered',
        'step 1 ask: prompt sent as private_reply',
        'step 1 ask: waiting for reply',
        'captured email',
        'step 2 send_dm: message sent as direct_message',
        'step 2 send_dm: delivered',
        'completed',
      ]);
    });

    it('ignores a redelivered comment webhook, and a second event for the same comment', async () => {
      const h = setup();
      await h.publish();

      await h.comment('pricing', { commentId: 'c-1', eventId: 'evt-1' });
      expect(await h.comment('pricing', { commentId: 'c-1', eventId: 'evt-1' })).toEqual({ status: 'duplicate' });
      expect(await h.comment('pricing', { commentId: 'c-1', eventId: 'evt-2' })).toEqual({
        status: 'matched',
        triggers: [{ automationId: 'pricing', status: 'already_triggered', runId: 'run-0001' }],
      });
      await h.runUntilIdle();

      expect(await store.tx((tx) => tx.getRun('run-0002'))).toBeNull();
      expect(h.sent()).toEqual([`reply_to_comment: ${TEXT.reply}`, `private_reply: ${TEXT.prompt}`]);
    });

    it('ignores a redelivered message webhook', async () => {
      const h = setup();
      const runId = await h.untilWaiting();

      expect(await h.message('hmm?', { eventId: 'm-1' })).toEqual({ status: 'delivered', runId, consumed: true });
      expect(await h.message('hmm?', { eventId: 'm-1' })).toEqual({ status: 'duplicate' });
      await h.runUntilIdle();

      expect(await h.run(runId)).toMatchObject({ status: 'waiting_reply', attempt: 1 });
      expect(h.sent()).toEqual([
        `reply_to_comment: ${TEXT.reply}`,
        `private_reply: ${TEXT.prompt}`,
        `direct_message: ${TEXT.reprompt}`,
      ]);
    });

    it("does not trigger on the account's own comment containing the keyword", async () => {
      const h = setup();
      await h.publish();

      expect(await h.comment('pricing is in your DMs', { from: ACCOUNT })).toEqual({ status: 'no_match' });
      await h.runUntilIdle();

      expect(h.platform.sendCalls).toEqual([]);
    });

    it('uses a reply that arrives before the prompt is acknowledged, without waiting for another one', async () => {
      const h = setup();
      // The contact answers in the gap between the platform accepting the prompt
      // and the worker recording it: the run is still awaiting_effect.
      let early: MessageResult | undefined;
      let unconsumedThen: unknown[] = [];
      h.platform.onDelivered(async (d) => {
        if (d.kind !== 'private_reply') return;
        early = await h.message('alice@example.com');
        unconsumedThen = await unconsumed(ALICE);
      });
      await h.publish();
      await h.comment('pricing');
      await h.runUntilIdle();

      expect(early).toEqual({ status: 'delivered', runId: 'run-0001', consumed: false });
      expect(unconsumedThen).toHaveLength(1);
      expect(await h.run('run-0001')).toMatchObject({ status: 'completed', context: { email: 'alice@example.com' } });
      expect(await unconsumed(ALICE)).toEqual([]);
      expect(h.sent()).toEqual([
        `reply_to_comment: ${TEXT.reply}`,
        `private_reply: ${TEXT.prompt}`,
        `direct_message: ${TEXT.link}`,
      ]);
      expect(await h.log('run-0001')).toEqual(
        expect.arrayContaining(['conversation window opened', 'step 1 ask: waiting for reply', 'captured email']),
      );
    });

    it('reprompts on a reply without an email, without extending the deadline, then completes', async () => {
      const h = setup();
      const runId = await h.untilWaiting();
      const { wakeAt } = await h.run(runId);

      h.clock.advance(3_600_000);
      await h.message('what do you need?');
      await h.runUntilIdle();
      expect(await h.run(runId)).toMatchObject({ status: 'waiting_reply', attempt: 1, wakeAt });

      await h.message('ok: alice@example.com');
      await h.runUntilIdle();

      expect(await h.run(runId)).toMatchObject({ status: 'completed', context: { email: 'alice@example.com' } });
      expect(h.sent()).toEqual([
        `reply_to_comment: ${TEXT.reply}`,
        `private_reply: ${TEXT.prompt}`,
        `direct_message: ${TEXT.reprompt}`,
        `direct_message: ${TEXT.link}`,
      ]);
    });

    it('fails the run with no_valid_reply when every attempt is used up', async () => {
      const h = setup();
      const runId = await h.untilWaiting();

      await h.message('no');
      await h.runUntilIdle();
      await h.message('nope');
      await h.runUntilIdle();
      expect(await h.message('still no')).toEqual({ status: 'delivered', runId, consumed: true });
      await h.runUntilIdle();

      expect(await h.run(runId)).toMatchObject({ status: 'failed', outcome: 'no_valid_reply' });
      expect(h.sent()).toEqual([
        `reply_to_comment: ${TEXT.reply}`,
        `private_reply: ${TEXT.prompt}`,
        `direct_message: ${TEXT.reprompt}`,
        `direct_message: ${TEXT.reprompt}`,
      ]);
    });

    it('expires a run nobody answers, and leaves a later message unmatched and unconsumed', async () => {
      const h = setup();
      const runId = await h.untilWaiting();

      h.clock.advance(TIMEOUT_MS);
      expect(await h.tick()).toMatchObject({ timers: 1 });
      expect(await h.run(runId)).toMatchObject({ status: 'expired', outcome: 'timeout' });

      expect(await h.message('alice@example.com', { eventId: 'late' })).toEqual({ status: 'unmatched' });
      await h.runUntilIdle();
      expect((await unconsumed(ALICE)).map((m) => m.id)).toEqual(['late']);
      expect(h.sent()).toEqual([`reply_to_comment: ${TEXT.reply}`, `private_reply: ${TEXT.prompt}`]);
    });

    it('lets a reply ingested at the deadline win over the timer due in the same tick', async () => {
      const h = setup();
      const runId = await h.untilWaiting();
      h.clock.set((await h.run(runId)).wakeAt!);

      await h.message('alice@example.com');
      await h.runUntilIdle();

      expect(await h.run(runId)).toMatchObject({ status: 'completed', outcome: 'completed' });
      expect(await h.log(runId)).not.toContain('expired: timeout');
      expect(h.sent().at(-1)).toBe(`direct_message: ${TEXT.link}`);
    });

    it('expires the run when the timer is processed first, and leaves the reply unmatched', async () => {
      const h = setup();
      const runId = await h.untilWaiting();
      h.clock.set((await h.run(runId)).wakeAt!);

      await h.tick();
      expect(await h.message('alice@example.com')).toEqual({ status: 'unmatched' });
      await h.runUntilIdle();

      expect(await h.run(runId)).toMatchObject({ status: 'expired', outcome: 'timeout' });
      expect(h.sent()).toEqual([`reply_to_comment: ${TEXT.reply}`, `private_reply: ${TEXT.prompt}`]);
    });

    it('queues a second automation for the same contact and promotes it when the first ends, asking only once', async () => {
      const h = setup();
      await h.publish({ id: 'demo-v1', automationId: 'demo', definition: DEMO });
      const first = await h.untilWaiting();

      expect(await h.comment('demo please')).toEqual({
        status: 'matched',
        triggers: [{ automationId: 'demo', status: 'created', runId: 'run-0002' }],
      });
      expect(await h.run('run-0002')).toMatchObject({ status: 'queued', startedAt: null });

      await h.message('alice@example.com');
      // The tick that settles the first run's link also hands the conversation to the second.
      await h.tick();
      expect(await h.run(first)).toMatchObject({ status: 'completed' });
      expect(await h.run('run-0002')).toMatchObject({ status: 'awaiting_effect', pendingEffectKey: 'run-0002:1:0' });

      await h.runUntilIdle();
      expect(await h.run('run-0002')).toMatchObject({ status: 'completed', context: { email: 'alice@example.com' } });
      expect(await h.log('run-0002')).toContain('step 0 ask: skipped, email already known');
      expect(h.platform.deliveries.at(-1)).toMatchObject({
        kind: 'private_reply',
        commentId: 'comment-2',
        text: TEXT.demoLink,
      });
      expect(h.platform.deliveries.filter((d) => d.text === TEXT.prompt || d.text === TEXT.demoPrompt)).toHaveLength(1);
    });

    // Found by test/simulation.test.ts (I3/I10). One comment has one private reply.
    // When a comment matched two automations, both runs used it: the second run's
    // first DM got `already_sent`, was recorded as sent, and never reached the contact.
    it('starts only one automation per comment, so a second run never mistakes the first run\'s private reply for its own', async () => {
      const h = setup();
      await h.publish();
      await h.publish({ id: 'demo-v1', automationId: 'demo', definition: DEMO });

      expect(await h.comment('pricing and a demo')).toEqual({
        status: 'matched',
        triggers: [
          { automationId: 'demo', status: 'created', runId: 'run-0001' },
          { automationId: 'pricing', status: 'comment_taken' },
        ],
      });
      // A new event for the same comment starts nothing new either.
      expect(await h.comment('pricing and a demo', { commentId: 'comment-1' })).toEqual({
        status: 'matched',
        triggers: [
          { automationId: 'demo', status: 'already_triggered', runId: 'run-0001' },
          { automationId: 'pricing', status: 'comment_taken' },
        ],
      });
      await h.runUntilIdle();
      await h.message('alice@example.com');
      await h.runUntilIdle();

      expect(await h.run('run-0001')).toMatchObject({ status: 'completed' });
      expect(await store.tx((tx) => tx.getRun('run-0002'))).toBeNull();
      expect(h.sent()).toEqual([`private_reply: ${TEXT.demoPrompt}`, `direct_message: ${TEXT.demoLink}`]);
    });

    it('skips a re-trigger by the same contact inside the cooldown window, and accepts one after it', async () => {
      const h = setup();
      await h.publish({ cooldownSeconds: 3600 });

      await h.comment('pricing');
      h.clock.advance(3_600_000);
      expect(await h.comment('pricing again')).toEqual({
        status: 'matched',
        triggers: [{ automationId: 'pricing', status: 'cooldown' }],
      });

      h.clock.advance(1);
      expect(await h.comment('pricing, third time')).toEqual({
        status: 'matched',
        triggers: [{ automationId: 'pricing', status: 'created', runId: 'run-0002' }],
      });
    });

    it('retries a retryable error after the backoff and delivers once', async () => {
      const h = setup();
      h.platform.inject({ kind: 'reply_to_comment' }, fault.retryable('server_error'));
      await h.publish();
      await h.comment('pricing');

      await h.runUntilIdle();
      expect(await h.effect('run-0001:0:0')).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError: 'server_error',
        nextAttemptAt: T0 + 1_000,
      });
      expect(h.sent()).toEqual([]);

      h.clock.advance(1_000);
      await h.runUntilIdle();
      expect(await h.effect('run-0001:0:0')).toMatchObject({ status: 'sent', attempts: 2 });
      expect(h.sent()).toEqual([`reply_to_comment: ${TEXT.reply}`, `private_reply: ${TEXT.prompt}`]);
    });

    it('throttles a rate-limited account without counting the attempt, while other accounts keep sending', async () => {
      const h = setup();
      await h.publish();
      await h.publish({ id: 'pricing-b-v1', automationId: 'pricing-b', accountId: OTHER_ACCOUNT });
      await h.comment('pricing', { from: 'alice' }); // run-0001, acct-1
      await h.comment('pricing', { from: 'bob' }); // run-0002, acct-1
      await h.comment('pricing', { from: 'carol', accountId: OTHER_ACCOUNT }); // run-0003, acct-2
      h.platform.inject({ key: 'run-0001:0:0' }, fault.rateLimited(30_000));

      expect((await h.tick()).effects).toMatchObject({ retrying: 1, deferred: 1, sent: 1 });
      expect(h.platform.sendCalls).toEqual(['run-0001:0:0', 'run-0003:0:0']);
      expect(await store.tx((tx) => tx.getAccountThrottle(ACCOUNT))).toBe(T0 + 30_000);
      expect(await h.effect('run-0001:0:0')).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: T0 + 30_000 });
      expect(await h.effect('run-0002:0:0')).toMatchObject({ status: 'pending', attempts: 0 });

      await h.runUntilIdle();
      expect(h.platform.sendCalls).not.toContain('run-0002:0:0');

      h.clock.advance(30_000);
      await h.runUntilIdle();
      const delivered = h.platform.deliveries.filter((d) => d.accountId === ACCOUNT).map((d) => d.key);
      expect(delivered.sort()).toEqual(['run-0001:0:0', 'run-0001:1:0', 'run-0002:0:0', 'run-0002:1:0']);
    });

    it('gives up on a public reply after the last attempt and lets the run continue', async () => {
      const h = setup({ maxEffectAttempts: 2, backoffMs: () => 1_000 });
      h.platform.inject({ kind: 'reply_to_comment' }, fault.retryable(), fault.retryable());
      await h.publish();
      await h.comment('pricing');

      for (let i = 0; i < 3; i++) {
        await h.runUntilIdle();
        h.clock.advance(1_000);
      }

      expect(await h.effect('run-0001:0:0')).toMatchObject({ status: 'failed', lastError: 'retries_exhausted', attempts: 3 });
      expect(h.platform.sendCalls.filter((k) => k === 'run-0001:0:0')).toHaveLength(2);
      expect(await h.run('run-0001')).toMatchObject({ status: 'waiting_reply' });
      expect(h.sent()).toEqual([`private_reply: ${TEXT.prompt}`]);
    });

    it('fails the run when the link DM runs out of attempts', async () => {
      const h = setup({ maxEffectAttempts: 2, backoffMs: () => 1_000 });
      const runId = await h.untilWaiting();
      h.platform.inject({ kind: 'direct_message' }, fault.retryable(), fault.retryable());
      await h.message('alice@example.com');

      for (let i = 0; i < 3; i++) {
        await h.runUntilIdle();
        h.clock.advance(1_000);
      }

      expect(await h.run(runId)).toMatchObject({ status: 'failed', outcome: 'effect_failed:retries_exhausted' });
      expect(h.sent()).toEqual([`reply_to_comment: ${TEXT.reply}`, `private_reply: ${TEXT.prompt}`]);
    });

    it('fails the run on a permanent DM error and promotes the queued run of the same conversation', async () => {
      const h = setup();
      await h.publish({ id: 'demo-v1', automationId: 'demo', definition: DEMO });
      const first = await h.untilWaiting();
      await h.comment('demo'); // run-0002, queued
      h.platform.inject({ kind: 'direct_message' }, fault.permanent('user_blocked'));

      await h.message('alice@example.com');
      await h.runUntilIdle();

      expect(await h.run(first)).toMatchObject({ status: 'failed', outcome: 'effect_failed:user_blocked' });
      expect(await h.effect('run-0001:2:0')).toMatchObject({ status: 'failed', lastError: 'user_blocked' });
      expect(await h.run('run-0002')).toMatchObject({ status: 'completed' });
      expect(h.sent()).toEqual([
        `reply_to_comment: ${TEXT.reply}`,
        `private_reply: ${TEXT.prompt}`,
        `private_reply: ${TEXT.demoLink}`,
      ]);
    });

    describe('crash after the platform accepted, before we recorded it', () => {
      it('private_reply (retry_safe): retried, the platform answers already_sent, delivered once', async () => {
        const h = setup();
        h.platform.inject({ key: 'run-0001:1:0' }, fault.throwAfter());
        await h.publish();
        await h.comment('pricing');

        await h.runUntilIdle();
        expect(await h.effect('run-0001:1:0')).toMatchObject({ status: 'pending', lastError: 'unknown_outcome' });

        h.clock.advance(1_000);
        await h.runUntilIdle();
        expect(h.platform.sendCalls.filter((k) => k === 'run-0001:1:0')).toHaveLength(2);
        expect(h.sent()).toEqual([`reply_to_comment: ${TEXT.reply}`, `private_reply: ${TEXT.prompt}`]);
        expect(await h.effect('run-0001:1:0')).toMatchObject({ status: 'sent' });
        expect(await h.run('run-0001')).toMatchObject({ status: 'waiting_reply' });
      });

      it('reply_to_comment (at_most_once): not resent; after the lease lapses reconcile says sent', async () => {
        const h = setup();
        h.platform.inject({ key: 'run-0001:0:0' }, fault.throwAfter());
        await h.publish();
        await h.comment('pricing');

        expect((await h.tick()).effects).toMatchObject({ in_doubt: 1 });
        await h.runUntilIdle();
        expect(await h.effect('run-0001:0:0')).toMatchObject({ status: 'sending' });
        expect(await h.run('run-0001')).toMatchObject({ status: 'awaiting_effect', pendingEffectKey: 'run-0001:0:0' });

        h.clock.advance(LEASE_MS);
        await h.runUntilIdle();
        expect(h.platform.reconcileCalls).toEqual(['run-0001:0:0']);
        expect(h.platform.sendCalls.filter((k) => k === 'run-0001:0:0')).toHaveLength(1);
        expect(h.sent()).toEqual([`reply_to_comment: ${TEXT.reply}`, `private_reply: ${TEXT.prompt}`]);
        expect(await h.run('run-0001')).toMatchObject({ status: 'waiting_reply' });
      });

      it('reply_to_comment (at_most_once): reconcile unknown is assumed sent and never resent', async () => {
        const h = setup();
        h.platform.inject({ key: 'run-0001:0:0' }, fault.throwAfter());
        h.platform.reconcileAnswers('unknown');
        await h.publish();
        await h.comment('pricing');

        await h.runUntilIdle();
        h.clock.advance(LEASE_MS);
        await h.runUntilIdle();

        expect(await h.effect('run-0001:0:0')).toMatchObject({ status: 'sent', lastError: 'unknown_outcome_assumed_sent' });
        expect(h.platform.sendCalls.filter((k) => k === 'run-0001:0:0')).toHaveLength(1);
        expect(h.sent()).toEqual([`reply_to_comment: ${TEXT.reply}`, `private_reply: ${TEXT.prompt}`]);
        expect(await h.run('run-0001')).toMatchObject({ status: 'waiting_reply' });
      });

      it('reply_to_comment (at_most_once): a throw before reaching the platform reconciles as not_sent and sends once', async () => {
        const h = setup();
        h.platform.inject({ key: 'run-0001:0:0' }, fault.throwBefore());
        await h.publish();
        await h.comment('pricing');

        await h.runUntilIdle();
        expect(h.sent()).toEqual([]);
        h.clock.advance(LEASE_MS);
        await h.runUntilIdle();

        expect(h.platform.reconcileCalls).toEqual(['run-0001:0:0']);
        expect(await h.effect('run-0001:0:0')).toMatchObject({ status: 'sent', attempts: 2 });
        expect(h.sent()).toEqual([`reply_to_comment: ${TEXT.reply}`, `private_reply: ${TEXT.prompt}`]);
      });

      it('direct_message (at_least_once): the link is delivered twice by design, and the run completes once', async () => {
        const h = setup();
        const runId = await h.untilWaiting();
        h.platform.inject({ kind: 'direct_message' }, fault.throwAfter());
        await h.message('alice@example.com');

        await h.runUntilIdle();
        h.clock.advance(1_000);
        await h.runUntilIdle();

        // The documented trade-off: a missing link loses the lead, a duplicate only annoys.
        expect(h.sent()).toEqual([
          `reply_to_comment: ${TEXT.reply}`,
          `private_reply: ${TEXT.prompt}`,
          `direct_message: ${TEXT.link}`,
          `direct_message: ${TEXT.link}`,
        ]);
        expect(await h.run(runId)).toMatchObject({ status: 'completed' });
        expect((await h.log(runId)).filter((e) => e === 'completed')).toHaveLength(1);
      });
    });

    it('reclaims an effect whose worker died between claim and send once the lease lapses, and applies its policy', async () => {
      const h = setup();
      await h.publish();
      await h.comment('pricing');
      // A worker claims the public reply and dies before calling the platform.
      expect(await store.tx((tx) => tx.claimDueEffects(h.clock.now(), 10, LEASE_MS))).toHaveLength(1);

      await h.runUntilIdle();
      expect(h.platform.sendCalls).toEqual([]);

      h.clock.advance(LEASE_MS);
      await h.runUntilIdle();
      expect(h.platform.reconcileCalls).toEqual(['run-0001:0:0']);
      expect(await h.effect('run-0001:0:0')).toMatchObject({ status: 'sent', attempts: 2 });
      expect(h.sent()).toEqual([`reply_to_comment: ${TEXT.reply}`, `private_reply: ${TEXT.prompt}`]);
    });

    // Found by test/simulation.test.ts (I4). The lease covers a whole claimed batch,
    // but the batch is sent one effect at a time. If the first send outlasts the
    // lease, a second worker reclaims the rest of the batch and sends it; the first
    // worker then reached the same effects and sent them again, with no
    // reconcile, because to it they were fresh claims.
    it('does not send a batched effect whose lease lapsed before its turn, even after another worker sent it', async () => {
      const h = setup({ batchSize: 2 });
      const other = createRuntime({ store, adapter: h.platform, now: h.clock.now, newId: createIds('other'), config: { batchSize: 2 } });
      await h.publish();
      await h.comment('pricing', { from: 'alice' });
      await h.comment('pricing', { from: 'bob' });

      let slowed = false;
      h.platform.onDelivered(async () => {
        if (slowed) return;
        slowed = true;
        // The first send of the batch is slow: the lease lapses and another worker runs.
        h.clock.advance(LEASE_MS + 1);
        await other.tick();
      });
      await h.tick();
      await h.runUntilIdle();

      const replies = h.platform.deliveries.filter((d) => d.kind === 'reply_to_comment').map((d) => d.key);
      expect(replies.sort()).toEqual(['run-0001:0:0', 'run-0002:0:0']);
    });

    it("does not take back another worker's claim: a lapsed batch member reclaimed by a worker that died after sending stays in doubt", async () => {
      const crashing = createFaultyStore(store);
      const h = setup({ batchSize: 2 });
      const other = createRuntime({ store: crashing, adapter: h.platform, now: h.clock.now, newId: createIds('other'), config: { batchSize: 2 } });
      await h.publish();
      await h.comment('pricing', { from: 'alice' });
      await h.comment('pricing', { from: 'bob' });

      let slowed = false;
      h.platform.onDelivered(async () => {
        if (slowed) return;
        slowed = true;
        h.clock.advance(LEASE_MS + 1);
        // The other worker reclaims both, reconciles alice's reply as sent, sends bob's,
        // and dies before recording it (its 5th transaction: claim, read, settle, read, settle).
        crashing.arm('before', 4);
        await expect(other.tick()).rejects.toBeInstanceOf(CrashError);
      });
      await h.tick();
      // Bob's reply is the dead worker's claim, in doubt: it must not go back to pending.
      expect(await h.effect('run-0002:0:0')).toMatchObject({ status: 'sending', attempts: 2 });

      h.clock.advance(LEASE_MS);
      await h.runUntilIdle();
      expect(h.platform.deliveries.filter((d) => d.key === 'run-0002:0:0')).toHaveLength(1);
      expect(await h.effect('run-0002:0:0')).toMatchObject({ status: 'sent' });
    });

    it('puts a batched effect whose lease lapsed before its turn back to pending, unsent and not in doubt', async () => {
      const h = setup({ batchSize: 2 });
      await h.publish();
      await h.comment('pricing', { from: 'alice' });
      await h.comment('pricing', { from: 'bob' });
      let slowed = false;
      h.platform.onDelivered(async () => {
        if (!slowed) h.clock.advance(LEASE_MS + 1);
        slowed = true;
      });

      expect((await h.tick()).effects).toMatchObject({ sent: 1, deferred: 1 });
      expect(await h.effect('run-0002:0:0')).toMatchObject({ status: 'pending', attempts: 0 });
      h.platform.reconcileAnswers('unknown'); // would wrongly mark it sent if it were treated as in flight
      await h.runUntilIdle();
      expect(h.platform.reconcileCalls).toEqual([]);
      expect(h.platform.deliveries.filter((d) => d.key === 'run-0002:0:0')).toHaveLength(1);
    });

    it('cancelling a run drops its pending effect undelivered and promotes the next queued run', async () => {
      const h = setup();
      await h.publish();
      await h.publish({ id: 'demo-v1', automationId: 'demo', definition: DEMO });
      await h.comment('pricing'); // run-0001 owns the conversation, public reply pending
      await h.comment('demo'); // run-0002, queued

      expect(await h.runtime.cancelRun('run-0001', 'owner_request')).toEqual({ status: 'cancelled' });
      expect(await h.runtime.cancelRun('run-0001', 'owner_request')).toEqual({
        status: 'already_ended',
        runStatus: 'cancelled',
      });
      expect(await h.run('run-0002')).toMatchObject({ status: 'awaiting_effect' });

      await h.runUntilIdle();
      expect(await h.effect('run-0001:0:0')).toMatchObject({ status: 'failed', lastError: 'run_ended' });
      expect(h.platform.sendCalls).not.toContain('run-0001:0:0');
      expect(await h.run('run-0001')).toMatchObject({ status: 'cancelled', outcome: 'cancelled:owner_request' });
      expect(await h.run('run-0002')).toMatchObject({ status: 'waiting_reply' });
      expect(h.sent()).toEqual([`private_reply: ${TEXT.demoPrompt}`]);
    });

    it('keeps a run on the version it started with; new comments use the latest; a disabled latest triggers nothing', async () => {
      const h = setup();
      const runId = await h.untilWaiting();
      const v2Link = 'New link: https://example.com/pricing-v2';
      const v2: AutomationDefinition = {
        ...PRICING,
        steps: PRICING.steps.map((s) => (s.type === 'send_dm' ? { ...s, text: v2Link } : s)),
      };
      await h.publish({ id: 'pricing-v2', definition: v2 });

      await h.message('alice@example.com');
      await h.runUntilIdle();
      expect(await h.run(runId)).toMatchObject({ status: 'completed', versionId: 'pricing-v1' });
      expect(h.sent().at(-1)).toBe(`direct_message: ${TEXT.link}`);

      await h.comment('pricing', { from: 'bob' });
      expect(await h.run('run-0002')).toMatchObject({ versionId: 'pricing-v2' });

      await h.publish({ id: 'pricing-v3', definition: v2, enabled: false });
      expect(await h.comment('pricing', { from: 'carol' })).toEqual({ status: 'no_match' });
    });

    it('rejects a definition that would send two DMs before the contact replies, and stores nothing', async () => {
      const h = setup();
      const result = await h.runtime.publishVersion({
        id: 'bad-v1',
        automationId: 'bad',
        accountId: ACCOUNT,
        enabled: true,
        cooldownSeconds: 0,
        definition: {
          trigger: PRICING.trigger,
          steps: [
            { type: 'send_dm', text: 'one' },
            { type: 'send_dm', text: 'two' },
          ],
        },
      });

      expect(result).toEqual({
        status: 'invalid',
        errors: [
          'steps.1: send_dm can run before the contact has replied, after the one private reply allowed per comment was already used',
        ],
      });
      expect(await h.comment('pricing')).toEqual({ status: 'no_match' });
    });

    it('stores a message from a contact with no run and leaves it unconsumed', async () => {
      const h = setup();
      await h.publish();

      expect(await h.message('hi, do you ship to Canada?', { from: 'stranger', eventId: 'm-1' })).toEqual({
        status: 'unmatched',
      });
      expect(await unconsumed('stranger')).toEqual([
        expect.objectContaining({ id: 'm-1', consumedByRunId: null, text: 'hi, do you ship to Canada?' }),
      ]);
    });

    it('ignores the echo of a message we sent and does not store it', async () => {
      const h = setup();
      const runId = await h.untilWaiting();

      const echo = { eventId: 'echo-1', accountId: ACCOUNT, contactId: ALICE, text: 'alice@example.com', at: T0, isEcho: true };
      expect(await h.runtime.ingestMessage(echo)).toEqual({ status: 'echo' });

      expect(await unconsumed(ALICE)).toEqual([]);
      expect(await h.run(runId)).toMatchObject({ status: 'waiting_reply', attempt: 0 });
    });
  });
}
