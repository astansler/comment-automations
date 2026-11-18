/**
 * Randomized whole-system simulation: a real runtime over the memory store,
 * the fake platform (which enforces Instagram's rules) and a manual clock,
 * driven by generated sequences of webhooks, redeliveries, worker ticks, clock
 * jumps, platform faults, cancellations, interleavings inside a send (a fast
 * reply, a second worker after the lease lapsed, a cancel), pairs of calls in
 * flight at once, and crashes at the storage boundary. Invariants I1-I15 are
 * checked after every action (I9 and I12 also after every commit); liveness is
 * checked at the end of every sequence. A coverage check at the end fails the
 * test if the generator stopped reaching the situations the invariants are about.
 *
 * Everything is deterministic (manual clock, sequential ids, no Math.random),
 * so a seed and path replay a failure exactly.
 *
 * Replaying a failure: fast-check prints `seed` and `path`. Re-run just that
 * case with
 *   SIM_SEED=<seed> SIM_PATH=<path> npx vitest run test/simulation.test.ts
 * SIM_RUNS=<n> changes how many sequences are generated (default 1000), and
 * SIM_SEED alone starts a fresh exploration from that seed.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { extractEmail } from '../src/core/engine.js';
import {
  isActive,
  isTerminal,
  type AskStep,
  type AutomationDefinition,
  type InboundComment,
  type InboundMessageEvent,
  type Run,
} from '../src/core/types.js';
import type { PlatformAdapter, SendResult } from '../src/runtime/adapter.js';
import { createRuntime, isIdle, TickError, type Runtime, type RuntimeConfig } from '../src/runtime/runtime.js';
import { createMemoryStore, type MemorySnapshot } from '../src/store/memory.js';
import type { StoredEffect } from '../src/store/store.js';
import { createFaultyStore, CrashError, type CrashMode } from './support/faultyStore.js';
import { createClock, createFakePlatform, createIds, type Delivery, type Fault } from './support/fakePlatform.js';

// ---------------------------------------------------------------------------
// The modelled world
// ---------------------------------------------------------------------------

const T0 = 1_750_000_000_000;
const LEASE_MS = 30_000;
const CONFIG: Omit<RuntimeConfig, 'batchSize'> = {
  leaseMs: LEASE_MS,
  maxEffectAttempts: 3,
  backoffMs: (attempt) => Math.min(1_000 * 2 ** (attempt - 1), 16_000),
  defaultThrottleMs: 10_000,
};
/** Longer than any lease, backoff, throttle or ask timeout below. */
const QUIESCENCE_STEP_MS = 130_000;
const LIVENESS_ITERATIONS = 300;

const ACCOUNTS = ['acct-a', 'acct-b'] as const;
const CONTACTS = ['c1', 'c2', 'c3', 'c4'] as const;

const trigger = (keywords: string[]): AutomationDefinition['trigger'] => ({
  type: 'comment_keyword',
  platform: 'instagram',
  keywords,
  match: 'contains',
  postIds: 'any',
});
const ask = (o: Partial<AskStep>): AskStep => ({
  type: 'ask',
  prompt: 'What is your email?',
  capture: 'email',
  saveAs: 'email',
  timeoutSeconds: 60,
  maxAttempts: 3,
  repromptText: 'That was not an email. Again?',
  ...o,
});

const DEFINITIONS: Record<'pricing' | 'demo' | 'promo', AutomationDefinition> = {
  // The brief's shape: skippable ask.
  pricing: {
    trigger: trigger(['pricing']),
    steps: [
      { type: 'reply_to_comment', text: 'Sent you a DM!' },
      ask({ prompt: 'Pricing: your email?', skipIfKnown: true, timeoutSeconds: 60, maxAttempts: 3 }),
      { type: 'send_dm', text: 'Pricing link for {{email}}' },
    ],
  },
  // Non-skippable ask with two attempts, then a second question (any answer), then the link.
  demo: {
    trigger: trigger(['demo']),
    steps: [
      ask({ prompt: 'Demo: your email?', timeoutSeconds: 120, maxAttempts: 2 }),
      ask({ prompt: 'Which company?', capture: 'any', saveAs: 'company', timeoutSeconds: 60, maxAttempts: 1 }),
      { type: 'send_dm', text: 'Demo link for {{email}} at {{company}}' },
    ],
  },
  // No ask at all.
  promo: {
    trigger: trigger(['promo']),
    steps: [
      { type: 'reply_to_comment', text: 'Check your DMs' },
      { type: 'send_dm', text: 'Promo code SIM' },
    ],
  },
};
const COOLDOWNS: Record<(typeof ACCOUNTS)[number], Record<keyof typeof DEFINITIONS, number>> = {
  'acct-a': { pricing: 0, demo: 90, promo: 0 },
  'acct-b': { pricing: 0, demo: 0, promo: 300 },
};

const COMMENT_TEXTS = [
  'pricing?',
  'Demo please',
  'PROMO!!',
  'pricing and a demo', // matches two automations with one comment
  'demo promo pricing', // matches three
  'hello there',
  'pricingx',
];
const MESSAGE_TEXTS = [
  'alice@example.com',
  'my email is Bob.Smith@Example.org thanks',
  'carol@test.io or dave@test.io',
  'no',
  '',
  '   ',
  'a..b@x.co',
];

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Hook =
  /** The contact answers while the platform call for our message is still in flight. */
  | { kind: 'reply'; text: number }
  /** A second worker runs a tick after the in-flight send's lease has lapsed; it may itself crash. */
  | { kind: 'worker'; crash: { mode: CrashMode; nth: number } | null }
  /** The run is cancelled while its send is in flight. */
  | { kind: 'cancel' };

type Action =
  | { t: 'comment'; acct: number; contact: number; text: number; variant: 'new' | 'redeliver' | 'new_event_old_comment'; pick: number; retryOnCrash: boolean }
  | { t: 'own_comment'; acct: number; text: number }
  | { t: 'message'; acct: number; contact: number; text: number; variant: 'new' | 'to_active_run' | 'redeliver'; pick: number; pastMs: number; retryOnCrash: boolean }
  | { t: 'tick'; worker: 0 | 1 }
  | { t: 'advance'; ms: number }
  | { t: 'fault'; fault: Fault }
  | { t: 'reconcile'; mode: 'truthfully' | 'unknown' }
  | { t: 'cancel'; pick: number }
  | { t: 'crash'; mode: CrashMode; nth: number }
  | { t: 'hook'; hook: Hook }
  /** Two calls in flight at once: their transactions interleave in the store. */
  | { t: 'concurrent'; calls: [Concurrent, Concurrent] };

type Concurrent =
  | { c: 'tick'; worker: 0 | 1 }
  | { c: 'reply'; text: number; pick: number }
  | { c: 'cancel'; pick: number }
  | { c: 'comment'; text: number; pick: number };

const idx = (n: number) => fc.nat({ max: n - 1 });

const concurrentArb: fc.Arbitrary<Concurrent> = fc.oneof(
  fc.record({ c: fc.constant('tick' as const), worker: fc.constantFrom(0 as const, 1 as const) }),
  fc.record({ c: fc.constant('reply' as const), text: idx(MESSAGE_TEXTS.length), pick: fc.nat() }),
  fc.record({ c: fc.constant('cancel' as const), pick: fc.nat() }),
  fc.record({ c: fc.constant('comment' as const), text: idx(COMMENT_TEXTS.length), pick: fc.nat() }),
);

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant('comment' as const),
      acct: idx(ACCOUNTS.length),
      contact: idx(CONTACTS.length),
      text: idx(COMMENT_TEXTS.length),
      variant: fc.constantFrom('new' as const, 'new' as const, 'redeliver' as const, 'new_event_old_comment' as const),
      pick: fc.nat(),
      retryOnCrash: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('own_comment' as const), acct: idx(ACCOUNTS.length), text: idx(COMMENT_TEXTS.length) }) },
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant('message' as const),
      acct: idx(ACCOUNTS.length),
      contact: idx(CONTACTS.length),
      text: idx(MESSAGE_TEXTS.length),
      variant: fc.constantFrom('new' as const, 'to_active_run' as const, 'to_active_run' as const, 'redeliver' as const),
      pick: fc.nat(),
      pastMs: fc.oneof(fc.constant(0), fc.constant(0), fc.integer({ min: 1, max: 5_000 })),
      retryOnCrash: fc.boolean(),
    }),
  },
  { weight: 10, arbitrary: fc.record({ t: fc.constant('tick' as const), worker: fc.constantFrom(0 as const, 1 as const) }) },
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant('advance' as const),
      ms: fc.oneof(
        fc.integer({ min: 1, max: 3_000 }), // small
        fc.integer({ min: 1_000, max: 16_000 }), // backoff-sized
        fc.constant(LEASE_MS), // exactly the lease
        fc.constant(LEASE_MS + 1), // just past it
        fc.integer({ min: 59_000, max: 125_000 }), // timeout-sized
      ),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('fault' as const),
      fault: fc.oneof(
        fc.constant<Fault>({ type: 'retryable', code: 'server_error' }),
        fc.option(fc.integer({ min: 1, max: 20_000 }), { nil: undefined }).map((retryAfterMs): Fault => ({ type: 'rate_limited', retryAfterMs })),
        fc.constant<Fault>({ type: 'permanent', code: 'user_blocked' }),
        fc.constant<Fault>({ type: 'throw_before' }),
        fc.constant<Fault>({ type: 'throw_after' }),
      ),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('reconcile' as const), mode: fc.constantFrom('truthfully' as const, 'unknown' as const) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('cancel' as const), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('crash' as const), mode: fc.constantFrom('before' as const, 'after' as const), nth: fc.nat({ max: 4 }) }) },
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant('hook' as const),
      hook: fc.oneof(
        idx(MESSAGE_TEXTS.length).map((text): Hook => ({ kind: 'reply', text })),
        fc
          .option(fc.record({ mode: fc.constantFrom('before' as const, 'after' as const), nth: fc.nat({ max: 6 }) }), { nil: null })
          .map((crash): Hook => ({ kind: 'worker', crash })),
        fc.constant<Hook>({ kind: 'cancel' }),
      ),
    }),
  },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('concurrent' as const), calls: fc.tuple(concurrentArb, concurrentArb) }) },
);

// ---------------------------------------------------------------------------
// One simulated world
// ---------------------------------------------------------------------------

const conv = (accountId: string, contactId: string): string => `${accountId}/${contactId}`;
const parseKey = (key: string): { runId: string; step: number; attempt: number } => {
  const [runId, step, attempt] = key.split(':');
  return { runId: runId!, step: Number(step), attempt: Number(attempt) };
};
const violation = (name: string, detail: string): never => {
  throw new Error(`${name} violated: ${detail}`);
};

/**
 * How often each interesting situation was reached, across all generated
 * sequences. Checked at the end so the generator cannot silently stop reaching
 * the states the invariants are about.
 */
const coverage = new Map<string, number>();
const hit = (what: string): void => {
  coverage.set(what, (coverage.get(what) ?? 0) + 1);
};

async function simulate(batchSize: number, actions: Action[]): Promise<void> {
  const clock = createClock(T0);
  const memory = createMemoryStore();
  const store = createFaultyStore(memory);
  const platform = createFakePlatform();
  const newId = createIds('run');

  // -- what the checks need beyond the store ----------------------------------
  /** Keys a fault or crash touched: the only ones allowed a duplicate direct_message. */
  const touched = new Set<string>();
  /** Rule breaches observed at the platform boundary. */
  const platformViolations: string[] = [];
  /** Sends started for a run that was already terminal. */
  const lateSends: string[] = [];
  /** Errors other than injected crashes, from anywhere (including hooks). */
  const unexpected: unknown[] = [];
  /** First terminal copy of each run (I9). */
  const terminalSeen = new Map<string, Run>();

  /** First moment each key reached the platform (I13). */
  const deliveredAt = new Map<string, number>();
  /** Sends that started inside an announced rate-limit window. */
  const throttleBreaches: string[] = [];
  /** > 0 while a `concurrent` action is running; some checks only hold without overlap. */
  let overlapping = 0;

  let nextFault: Fault | null = null;
  let hook: Hook | null = null;
  const inFlight = new Map<string, number>();

  const adapter: PlatformAdapter = {
    async send(effect) {
      if (overlapping === 0) {
        // With calls overlapping, a cancel may commit between the worker's pre-send read
        // and the send, and a worker may hold claims made before a throttle was announced.
        const committed = memory.snapshot();
        const run = committed.runs.find((r) => r.id === effect.runId);
        if (run === undefined || isTerminal(run.status)) {
          lateSends.push(`${effect.key} while run is ${run?.status ?? 'missing'}`);
        }
        const throttle = committed.throttles.find((t) => t.accountId === effect.accountId && t.kind === effect.kind);
        if (throttle !== undefined && clock.now() < throttle.until) {
          throttleBreaches.push(`${effect.key} at ${clock.now()}, ${effect.kind} throttled until ${throttle.until}`);
        }
      }
      // A second send of a key while the first is still in flight: a lapsed lease.
      if ((inFlight.get(effect.key) ?? 0) > 0) touched.add(effect.key);
      inFlight.set(effect.key, (inFlight.get(effect.key) ?? 0) + 1);
      try {
        const f = nextFault;
        nextFault = null;
        switch (f?.type) {
          case 'throw_before':
            throw new Error('network error before the platform');
          case 'retryable':
            return { ok: false, error: { kind: 'retryable', code: f.code } };
          case 'rate_limited':
            return {
              ok: false,
              error: {
                kind: 'retryable',
                code: 'rate_limited',
                rateLimited: true,
                ...(f.retryAfterMs === undefined ? {} : { retryAfterMs: f.retryAfterMs }),
              },
            };
          case 'permanent':
            return { ok: false, error: { kind: 'permanent', code: f.code } };
        }
        const deliveredBefore = platform.deliveries.some((d) => d.key === effect.key);
        const result: SendResult = await platform.send(effect);
        if (!result.ok && result.error.kind === 'permanent' && result.error.code === 'window_closed') {
          platformViolations.push(`${effect.key}: direct_message before the contact wrote (window_closed)`);
        }
        if (!result.ok && result.error.kind === 'already_sent' && deliveredBefore) hit('private reply already_sent');
        if (!result.ok && result.error.kind === 'already_sent' && !deliveredBefore) {
          platformViolations.push(
            `${effect.key}: platform answered already_sent, but this key was never delivered; another run used the comment's private reply`,
          );
        }
        if (f?.type === 'throw_after') {
          touched.add(effect.key);
          throw new Error('connection lost after the platform accepted');
        }
        return result;
      } finally {
        inFlight.set(effect.key, inFlight.get(effect.key)! - 1);
      }
    },
    reconcile: (effect) => platform.reconcile(effect),
  };

  const runtimeConfig = { ...CONFIG, batchSize };
  const workers: Runtime[] = [0, 1].map(() =>
    createRuntime({ store, adapter, now: clock.now, newId, config: runtimeConfig }),
  );
  const runtime = workers[0]!;

  /** A dead process: everything that was `sending` at the crash may have reached the platform. */
  function noteCrash(): void {
    for (const e of memory.snapshot().effects) if (e.status === 'sending') touched.add(e.key);
  }
  /** Runs a call as one process would: an injected crash kills it; anything else is a finding. */
  async function guarded(call: () => Promise<unknown>): Promise<'ok' | 'crashed'> {
    try {
      await call();
      return 'ok';
    } catch (err) {
      // A worker pass isolates failures per item, so one pass can meet two armed crashes.
      const errors: unknown[] = err instanceof TickError ? err.errors : [err];
      const crashes = errors.filter((e) => e instanceof CrashError);
      for (const crash of crashes) hit(`crash ${crash.mode} commit`);
      if (crashes.length > 0) noteCrash();
      unexpected.push(...errors.filter((e) => !(e instanceof CrashError)));
      return crashes.length > 0 ? 'crashed' : 'ok';
    }
  }

  platform.onDelivered(async (delivery: Delivery) => {
    if (!deliveredAt.has(delivery.key)) deliveredAt.set(delivery.key, clock.now());
    const h = hook;
    if (h === null) return;
    hook = null;
    hit(`hook ${h.kind}`);
    switch (h.kind) {
      case 'reply':
        await guarded(() => ingestMessage(delivery.accountId, delivery.contactId, MESSAGE_TEXTS[h.text]!, 0));
        return;
      case 'worker':
        touched.add(delivery.key);
        clock.advance(LEASE_MS + 1);
        if (h.crash !== null) store.arm(h.crash.mode, h.crash.nth);
        await guarded(() => tick(1));
        return;
      case 'cancel':
        await guarded(() => runtime.cancelRun(parseKey(delivery.key).runId, 'hook'));
        return;
    }
  });

  const comments: InboundComment[] = [];
  const messages: InboundMessageEvent[] = [];
  let seq = 0;

  /** Messages that were stored without being consumed on arrival (to count later drains). */
  const unconsumedOnArrival = new Set<string>();

  // The runtime's entry points, recording what they report for the coverage check.
  async function ingestComment(c: InboundComment): Promise<void> {
    const result = await runtime.ingestComment(c);
    if (result.status === 'matched') for (const t of result.triggers) hit(`trigger ${t.status}`);
    else hit(`comment ${result.status}`);
  }
  async function deliverMessage(m: InboundMessageEvent): Promise<void> {
    platform.contactMessaged(m.accountId, m.contactId);
    const result = await runtime.ingestMessage(m);
    hit(result.status === 'delivered' ? `message delivered, consumed=${result.consumed}` : `message ${result.status}`);
    if (result.status === 'unmatched' || (result.status === 'delivered' && !result.consumed)) unconsumedOnArrival.add(m.eventId);
  }
  async function tick(worker: number): Promise<void> {
    const report = await workers[worker]!.tick();
    for (const [outcome, n] of Object.entries(report.effects)) if (n > 0) hit(`effect ${outcome}`);
    if (report.timers > 0) hit('timer fired');
  }
  function ingestMessage(accountId: string, contactId: string, text: string, pastMs: number): Promise<void> {
    const m: InboundMessageEvent = { eventId: `msg-${++seq}`, accountId, contactId, text, at: clock.now() - pastMs };
    messages.push(m);
    return deliverMessage(m);
  }

  // Publishing is set-up, not under test here.
  for (const accountId of ACCOUNTS) {
    for (const [name, definition] of Object.entries(DEFINITIONS)) {
      const result = await runtime.publishVersion({
        id: `${accountId}-${name}-v1`,
        automationId: `${accountId}-${name}`,
        accountId,
        enabled: true,
        cooldownSeconds: COOLDOWNS[accountId][name as keyof typeof DEFINITIONS],
        definition,
      });
      if (result.status !== 'published') throw new Error(`setup: ${JSON.stringify(result)}`);
    }
  }

  async function exec(a: Action): Promise<void> {
    switch (a.t) {
      case 'comment': {
        let c: InboundComment;
        const old = comments.length > 0 ? comments[a.pick % comments.length]! : null;
        if (a.variant === 'redeliver' && old !== null) c = old;
        else if (a.variant === 'new_event_old_comment' && old !== null) c = { ...old, eventId: `cevt-${++seq}`, at: clock.now() };
        else {
          const accountId = ACCOUNTS[a.acct]!;
          const n = ++seq;
          c = { eventId: `cevt-${n}`, accountId, commentId: `cmt-${n}`, postId: 'post-1', authorId: CONTACTS[a.contact]!, text: COMMENT_TEXTS[a.text]!, at: clock.now() };
          comments.push(c);
        }
        if ((await guarded(() => ingestComment(c))) === 'crashed' && a.retryOnCrash) {
          await guarded(() => ingestComment(c)); // the platform redelivers
        }
        return;
      }
      case 'own_comment': {
        const accountId = ACCOUNTS[a.acct]!;
        const n = ++seq;
        const c: InboundComment = { eventId: `cevt-${n}`, accountId, commentId: `cmt-${n}`, postId: 'post-1', authorId: accountId, text: COMMENT_TEXTS[a.text]!, at: clock.now() };
        await guarded(() => ingestComment(c));
        return;
      }
      case 'message': {
        const old = messages.length > 0 ? messages[a.pick % messages.length]! : null;
        if (a.variant === 'redeliver' && old !== null) {
          if ((await guarded(() => deliverMessage(old))) === 'crashed' && a.retryOnCrash) {
            await guarded(() => deliverMessage(old));
          }
          return;
        }
        let accountId: string = ACCOUNTS[a.acct]!;
        let contactId: string = CONTACTS[a.contact]!;
        if (a.variant === 'to_active_run') {
          // Most interesting replies are to a conversation some run owns.
          const owners = memory.snapshot().runs.filter((r) => isActive(r.status));
          const owner = owners.length > 0 ? owners[a.pick % owners.length]! : null;
          if (owner !== null) ({ accountId, contactId } = owner);
        }
        if ((await guarded(() => ingestMessage(accountId, contactId, MESSAGE_TEXTS[a.text]!, a.pastMs))) === 'crashed' && a.retryOnCrash) {
          const m = messages.at(-1)!;
          await guarded(() => deliverMessage(m));
        }
        return;
      }
      case 'tick':
        await guarded(() => tick(a.worker));
        return;
      case 'advance':
        clock.advance(a.ms);
        return;
      case 'fault':
        nextFault = a.fault;
        return;
      case 'reconcile':
        platform.reconcileAnswers(a.mode);
        return;
      case 'cancel': {
        const runs = memory.snapshot().runs;
        if (runs.length === 0) return;
        const run = runs[a.pick % runs.length]!;
        await guarded(() => runtime.cancelRun(run.id, 'operator'));
        return;
      }
      case 'crash':
        store.arm(a.mode, a.nth);
        return;
      case 'hook':
        hook = a.hook;
        return;
      case 'concurrent':
        overlapping++;
        try {
          await Promise.all(a.calls.map((call) => guarded(() => concurrent(call))));
        } finally {
          overlapping--;
        }
        return;
    }
  }

  async function concurrent(call: Concurrent): Promise<void> {
    const runs = memory.snapshot().runs;
    switch (call.c) {
      case 'tick':
        return tick(call.worker);
      case 'reply': {
        const owners = runs.filter((r) => isActive(r.status));
        const owner = owners[call.pick % Math.max(owners.length, 1)];
        if (owner === undefined) return;
        return ingestMessage(owner.accountId, owner.contactId, MESSAGE_TEXTS[call.text]!, 0);
      }
      case 'cancel': {
        const run = runs[call.pick % Math.max(runs.length, 1)];
        if (run === undefined) return;
        await runtime.cancelRun(run.id, 'operator');
        return;
      }
      case 'comment': {
        // A new comment by a contact who already has a run, to collide on the conversation.
        const author = runs[call.pick % Math.max(runs.length, 1)];
        const accountId = author?.accountId ?? ACCOUNTS[0];
        const n = ++seq;
        const c: InboundComment = { eventId: `cevt-${n}`, accountId, commentId: `cmt-${n}`, postId: 'post-1', authorId: author?.contactId ?? CONTACTS[0], text: COMMENT_TEXTS[call.text]!, at: clock.now() };
        comments.push(c);
        return ingestComment(c);
      }
    }
  }

  // -- invariants -------------------------------------------------------------

  let checkpoint = 0;
  /** Checkpoint at which a conversation's lead / a run's start was first visible (I11). */
  const leadSeen = new Map<string, number>();
  const startSeen = new Map<string, number>();
  /** First settled copy of each effect (I12). */
  const settledSeen = new Map<string, StoredEffect>();

  function checkAll(snap: MemorySnapshot, before: MemorySnapshot, step: string): void {
    const ctx = `after ${step}`;
    if (unexpected.length > 0) {
      const err = unexpected[0];
      violation('no unexpected error', `${ctx}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
    const runsById = new Map(snap.runs.map((r) => [r.id, r]));
    const effectsByKey = new Map(snap.effects.map((e) => [e.key, e]));
    const deliveries = platform.deliveries;

    // I1. At most one run per conversation is active, no run is persisted `running`,
    //     and queued runs exist only behind an active run (nothing is stranded in the queue).
    {
      const active = new Map<string, number>();
      const queued = new Set<string>();
      for (const r of snap.runs) {
        if (r.status === 'running') violation('I1', `${ctx}: run ${r.id} persisted as running`);
        const c = conv(r.accountId, r.contactId);
        if (isActive(r.status)) active.set(c, (active.get(c) ?? 0) + 1);
        if (r.status === 'queued') queued.add(c);
      }
      for (const [c, n] of active) if (n > 1) violation('I1', `${ctx}: ${n} active runs in conversation ${c}`);
      for (const c of queued) if (!active.has(c)) violation('I1', `${ctx}: conversation ${c} has queued runs but no active run`);
    }

    // I2. At most one run per trigger comment (so per (automation, comment)); no run is started
    //     by the account's own comment; two runs of an automation with a cooldown for the same
    //     contact were created more than the cooldown apart.
    {
      const seen = new Set<string>();
      for (const r of snap.runs) {
        const k = `${r.accountId}|${r.triggerCommentId}`;
        if (seen.has(k)) violation('I2', `${ctx}: two runs for comment ${k}`);
        seen.add(k);
        if (r.contactId === r.accountId) violation('I2', `${ctx}: run ${r.id} started by the account's own comment`);
      }
      for (const a of snap.runs) {
        const name = a.automationId.slice(a.accountId.length + 1) as keyof typeof DEFINITIONS;
        const cooldownMs = COOLDOWNS[a.accountId as (typeof ACCOUNTS)[number]][name] * 1000;
        if (cooldownMs === 0) continue;
        for (const b of snap.runs) {
          if (b.id !== a.id && b.automationId === a.automationId && b.contactId === a.contactId && b.createdAt >= a.createdAt && b.createdAt - a.createdAt <= cooldownMs) {
            violation('I2', `${ctx}: runs ${a.id} and ${b.id} of ${a.automationId} for ${a.contactId} created ${b.createdAt - a.createdAt} ms apart, cooldown ${cooldownMs} ms`);
          }
        }
      }
    }

    // I3. The platform never refused a send for breaking its rules: no direct_message
    //     outside the window, no private reply answered "already sent" unless that same
    //     key had been delivered; and at most one private reply was delivered per comment.
    {
      if (platformViolations.length > 0) violation('I3', `${ctx}: ${platformViolations[0]}`);
      const perComment = new Map<string, number>();
      for (const d of deliveries) {
        if (d.kind !== 'private_reply') continue;
        perComment.set(d.commentId, (perComment.get(d.commentId) ?? 0) + 1);
      }
      for (const [c, n] of perComment) if (n > 1) violation('I3', `${ctx}: ${n} private replies to comment ${c}`);
    }

    // I4. reply_to_comment and private_reply are delivered at most once per effect key under
    //     every fault; a direct_message is delivered more than once only if a throw-after-delivery,
    //     a crash while it was `sending`, or a lapsed lease during its send touched that key.
    {
      const count = new Map<string, { n: number; kind: string }>();
      for (const d of deliveries) count.set(d.key, { n: (count.get(d.key)?.n ?? 0) + 1, kind: d.kind });
      for (const [key, { n, kind }] of count) {
        if (n <= 1) continue;
        if (kind !== 'direct_message') violation('I4', `${ctx}: ${kind} ${key} delivered ${n} times`);
        if (!touched.has(key)) violation('I4', `${ctx}: direct_message ${key} delivered ${n} times with no fault on it`);
      }
    }

    // I5. A run is awaiting_effect iff its pendingEffectKey names an effect of that run that is
    //     pending or sending; every pending/sending effect belongs to a run that is awaiting
    //     exactly that key or has ended; no other run carries a pendingEffectKey.
    {
      for (const r of snap.runs) {
        if (r.status === 'awaiting_effect') {
          const e = r.pendingEffectKey === null ? undefined : effectsByKey.get(r.pendingEffectKey);
          if (e === undefined || e.runId !== r.id || (e.status !== 'pending' && e.status !== 'sending')) {
            violation('I5', `${ctx}: run ${r.id} awaits ${r.pendingEffectKey} which is ${e?.status ?? 'missing'}`);
          }
        } else if (r.pendingEffectKey !== null) {
          violation('I5', `${ctx}: run ${r.id} is ${r.status} but has pendingEffectKey ${r.pendingEffectKey}`);
        }
      }
      for (const e of snap.effects) {
        if (e.status !== 'pending' && e.status !== 'sending') continue;
        const r = runsById.get(e.runId);
        if (r === undefined) violation('I5', `${ctx}: effect ${e.key} has no run`);
        else if (!isTerminal(r.status) && !(r.status === 'awaiting_effect' && r.pendingEffectKey === e.key)) {
          violation('I5', `${ctx}: effect ${e.key} is ${e.status} but run ${r.id} is ${r.status} awaiting ${r.pendingEffectKey}`);
        }
      }
    }

    // I6. A consumed message was consumed by a run of its own conversation that had started
    //     at or before the message's receivedAt; a run consumes at most maxAttempts messages
    //     per ask step; and no run expires while a reply it could have used sits unconsumed:
    //     a message of its conversation, stored before the expiry, received since the run
    //     started, and either written after the question was enqueued or carrying the email
    //     the question asks for (an earlier message that is not the answer is left alone).
    {
      const consumedBy = new Map<string, number>();
      for (const m of snap.messages) {
        if (m.consumedByRunId === null) continue;
        const r = runsById.get(m.consumedByRunId);
        if (r === undefined) violation('I6', `${ctx}: message ${m.id} consumed by missing run`);
        else {
          if (r.accountId !== m.accountId || r.contactId !== m.contactId) {
            violation('I6', `${ctx}: message ${m.id} of ${conv(m.accountId, m.contactId)} consumed by run ${r.id} of ${conv(r.accountId, r.contactId)}`);
          }
          if (r.startedAt === null || m.receivedAt < r.startedAt) {
            violation('I6', `${ctx}: message ${m.id} received at ${m.receivedAt} consumed by run ${r.id} started at ${r.startedAt}`);
          }
        }
        consumedBy.set(m.consumedByRunId, (consumedBy.get(m.consumedByRunId) ?? 0) + 1);
      }
      for (const [runId, n] of consumedBy) {
        const r = runsById.get(runId)!;
        const automation = r.automationId.slice(r.accountId.length + 1) as keyof typeof DEFINITIONS;
        const budget = DEFINITIONS[automation].steps.reduce((s, st) => s + (st.type === 'ask' ? st.maxAttempts : 0), 0);
        if (n > budget) violation('I6', `${ctx}: run ${runId} consumed ${n} messages, budget ${budget}`);
      }
      // Every reply a run examined (its log says so) is marked consumed by it, and vice versa.
      const examined = new Map<string, number>();
      for (const entry of snap.runLog) {
        if (entry.entry.startsWith('captured ') || entry.entry.includes(': nothing to capture (')) {
          examined.set(entry.runId, (examined.get(entry.runId) ?? 0) + 1);
        }
      }
      for (const r of snap.runs) {
        if ((examined.get(r.id) ?? 0) !== (consumedBy.get(r.id) ?? 0)) {
          violation('I6', `${ctx}: run ${r.id} examined ${examined.get(r.id) ?? 0} replies but ${consumedBy.get(r.id) ?? 0} messages are marked consumed by it`);
        }
      }
      const storedBefore = new Set(before.messages.map((m) => m.id));
      for (const r of snap.runs) {
        if (r.status !== 'expired' || terminalSeen.has(r.id)) continue;
        const automation = r.automationId.slice(r.accountId.length + 1) as keyof typeof DEFINITIONS;
        const step = DEFINITIONS[automation].steps[r.stepIndex];
        const askedAt = effectsByKey.get(`${r.id}:${r.stepIndex}:0`)?.createdAt ?? Infinity;
        const lost = snap.messages.find(
          (m) =>
            storedBefore.has(m.id) &&
            m.consumedByRunId === null &&
            m.accountId === r.accountId &&
            m.contactId === r.contactId &&
            r.startedAt !== null &&
            m.receivedAt >= r.startedAt &&
            (m.receivedAt >= askedAt ||
              (step?.type === 'ask' && step.capture === 'email' && extractEmail(m.text) !== null)),
        );
        if (lost !== undefined) violation('I6', `${ctx}: run ${r.id} expired while message ${lost.id} waited unconsumed`);
      }
    }

    // I7. Within a run, deliveries are in non-decreasing (step, attempt) order; and no send is
    //     ever started for a run that had already ended (sends already in flight when the run
    //     ended may still land).
    {
      if (lateSends.length > 0) violation('I7', `${ctx}: send started for an ended run: ${lateSends[0]}`);
      const last = new Map<string, [number, number]>();
      for (const d of deliveries) {
        const { runId, step, attempt } = parseKey(d.key);
        const prev = last.get(runId);
        if (prev !== undefined && (step < prev[0] || (step === prev[0] && attempt < prev[1]))) {
          violation('I7', `${ctx}: run ${runId} delivered ${d.key} after ${runId}:${prev[0]}:${prev[1]}`);
        }
        last.set(runId, [step, attempt]);
      }
    }

    // I8. Every stored lead value was captured from some message that contact sent: the email
    //     extracted from it for `email`, its trimmed text for the free-text `company` field.
    {
      for (const l of snap.leads) {
        const ok = snap.messages.some(
          (m) =>
            m.accountId === l.accountId &&
            m.contactId === l.contactId &&
            (l.field === 'email' ? extractEmail(m.text) : m.text.trim()) === l.value,
        );
        if (!ok) violation('I8', `${ctx}: lead ${l.field}=${l.value} of ${conv(l.accountId, l.contactId)} came from no message`);
      }
    }

    // I9. A terminal run never changes again.
    {
      for (const r of snap.runs) {
        const first = terminalSeen.get(r.id);
        if (first !== undefined && JSON.stringify(first) !== JSON.stringify(r)) {
          violation('I9', `${ctx}: terminal run ${r.id} changed from ${JSON.stringify(first)} to ${JSON.stringify(r)}`);
        }
        if (first === undefined && isTerminal(r.status)) terminalSeen.set(r.id, r);
      }
    }

    // I10. An effect recorded as `sent` reached the platform under that key, unless it is an
    //      at_most_once effect explicitly recorded as `unknown_outcome_assumed_sent`.
    {
      for (const e of snap.effects) {
        if (e.status !== 'sent' || e.lastError === 'unknown_outcome_assumed_sent') continue;
        if (!deliveries.some((d) => d.key === e.key)) violation('I10', `${ctx}: effect ${e.key} is sent but was never delivered`);
      }
    }

    // I11. A skipIfKnown question is never sent to a contact whose answer was already stored
    //      when the run started (checkpoint granularity: the lead was visible at an earlier check
    //      than the one where the run was first seen started).
    {
      checkpoint++;
      for (const l of snap.leads) if (!leadSeen.has(conv(l.accountId, l.contactId))) leadSeen.set(conv(l.accountId, l.contactId), checkpoint);
      for (const r of snap.runs) if (r.startedAt !== null && !startSeen.has(r.id)) startSeen.set(r.id, checkpoint);
      for (const d of deliveries) {
        const { runId, step, attempt } = parseKey(d.key);
        const r = runsById.get(runId);
        if (r === undefined || attempt !== 0) continue;
        const automation = r.automationId.slice(r.accountId.length + 1) as keyof typeof DEFINITIONS;
        const s = DEFINITIONS[automation].steps[step];
        if (s?.type !== 'ask' || s.skipIfKnown !== true) continue;
        const known = leadSeen.get(conv(r.accountId, r.contactId));
        const started = startSeen.get(r.id);
        if (known !== undefined && started !== undefined && known < started) {
          violation('I11', `${ctx}: run ${r.id} asked ${d.key} although the contact's email was stored before it started`);
        }
      }
    }

    // I12. A settled effect (`sent` or `failed`) never changes again.
    {
      for (const e of snap.effects) {
        const first = settledSeen.get(e.key);
        if (first !== undefined && JSON.stringify(first) !== JSON.stringify(e)) {
          violation('I12', `${ctx}: settled effect ${e.key} changed from ${JSON.stringify(first)} to ${JSON.stringify(e)}`);
        }
        if (first === undefined && (e.status === 'sent' || e.status === 'failed')) settledSeen.set(e.key, e);
      }
    }

    // I13. A run never expires before its question's timeout has elapsed since that question
    //      was first delivered.
    {
      for (const r of snap.runs) {
        if (r.status !== 'expired' || terminalSeen.has(r.id)) continue;
        const automation = r.automationId.slice(r.accountId.length + 1) as keyof typeof DEFINITIONS;
        const step = DEFINITIONS[automation].steps[r.stepIndex];
        const askedAt = deliveredAt.get(`${r.id}:${r.stepIndex}:0`);
        if (step?.type !== 'ask' || askedAt === undefined) {
          violation('I13', `${ctx}: run ${r.id} expired at step ${r.stepIndex} whose question was never delivered`);
        } else if (r.updatedAt < askedAt + step.timeoutSeconds * 1000) {
          violation('I13', `${ctx}: run ${r.id} expired at ${r.updatedAt}, question delivered at ${askedAt}, timeout ${step.timeoutSeconds}s`);
        }
      }
    }

    // I14. While no other call overlaps, no send for an account starts while a recorded throttle
    //      for that account (the platform's retry-after, once committed) is still in the future.
    if (throttleBreaches.length > 0) violation('I14', `${ctx}: ${throttleBreaches[0]}`);

    // I15. A failed public reply never ends a run: a run fails on a send only at a DM step.
    {
      for (const r of snap.runs) {
        if (r.status !== 'failed' || !r.outcome?.startsWith('effect_failed:')) continue;
        const automation = r.automationId.slice(r.accountId.length + 1) as keyof typeof DEFINITIONS;
        if (DEFINITIONS[automation].steps[r.stepIndex]?.type === 'reply_to_comment') {
          violation('I15', `${ctx}: run ${r.id} failed (${r.outcome}) on its public reply`);
        }
      }
    }
  }

  // I9 and I12 are also checked after every single commit, not only between actions: a stale
  // worker overwriting a settled effect inside the same action would otherwise go unseen.
  const committedTerminal = new Map<string, string>();
  const committedSettled = new Map<string, string>();
  store.onCommit(() => {
    const snap = memory.snapshot();
    for (const r of snap.runs) {
      const json = JSON.stringify(r);
      const first = committedTerminal.get(r.id);
      if (first !== undefined && first !== json) unexpected.push(new Error(`I9 violated at a commit: terminal run ${r.id} changed from ${first} to ${json}`));
      if (first === undefined && isTerminal(r.status)) committedTerminal.set(r.id, json);
    }
    for (const e of snap.effects) {
      const json = JSON.stringify(e);
      const first = committedSettled.get(e.key);
      if (first !== undefined && first !== json) unexpected.push(new Error(`I12 violated at a commit: settled effect ${e.key} changed from ${first} to ${json}`));
      if (first === undefined && (e.status === 'sent' || e.status === 'failed')) committedSettled.set(e.key, json);
    }
  });

  // -- drive ------------------------------------------------------------------

  let before = memory.snapshot();
  for (const [i, a] of actions.entries()) {
    await exec(a);
    const snap = memory.snapshot();
    checkAll(snap, before, `action ${i} ${JSON.stringify(a)}`);
    before = snap;
  }

  // Liveness: with faults off and reconcile truthful, the system drains to rest.
  store.disarm();
  nextFault = null;
  hook = null;
  platform.reconcileAnswers('truthfully');
  for (let i = 0; ; i++) {
    if (i === LIVENESS_ITERATIONS) {
      const snap = memory.snapshot();
      violation(
        'liveness',
        `not quiescent after ${LIVENESS_ITERATIONS} iterations: runs ${JSON.stringify(snap.runs.filter((r) => !isTerminal(r.status)))} effects ${JSON.stringify(snap.effects.filter((e) => e.status === 'pending' || e.status === 'sending'))}`,
      );
    }
    let report;
    try {
      report = await runtime.tick();
    } catch (err) {
      unexpected.push(err);
    }
    const snap = memory.snapshot();
    checkAll(snap, before, `liveness tick ${i}`);
    before = snap;
    if (report === undefined || !isIdle(report)) continue;
    const runsDone = snap.runs.every((r) => isTerminal(r.status));
    const effectsDone = snap.effects.every((e) => e.status === 'sent' || e.status === 'failed');
    if (runsDone && effectsDone) break;
    clock.advance(QUIESCENCE_STEP_MS);
  }

  const final = memory.snapshot();
  for (const r of final.runs) hit(`run ${r.status}: ${r.outcome?.replace(/:.*/, '')}`);
  for (const e of final.effects) if (e.lastError !== null) hit(`effect ${e.status}, ${e.lastError}`);
  for (const m of final.messages) if (m.consumedByRunId !== null && unconsumedOnArrival.has(m.id)) hit('message drained later');
  const delivered = new Map<string, number>();
  for (const d of platform.deliveries) delivered.set(d.key, (delivered.get(d.key) ?? 0) + 1);
  for (const [key, n] of delivered) {
    if (n > 1) hit('direct_message duplicated');
    if (parseKey(key).attempt > 0) hit('reprompt delivered');
  }
}

// ---------------------------------------------------------------------------

const REQUIRED_COVERAGE = [
  'crash before commit',
  'crash after commit',
  'hook reply',
  'hook worker',
  'hook cancel',
  'trigger created',
  'trigger already_triggered',
  'trigger comment_taken',
  'trigger cooldown',
  'comment duplicate',
  'message duplicate',
  'message unmatched',
  'message delivered, consumed=true',
  'message drained later',
  'reprompt delivered',
  'private reply already_sent',
  'direct_message duplicated',
  'effect retrying',
  'effect deferred',
  'effect in_doubt',
  'effect superseded',
  'effect failed, run_ended',
  'effect failed, retries_exhausted',
  'effect sent, unknown_outcome_assumed_sent',
  'timer fired',
  'run completed: completed',
  'run expired: timeout',
  'run failed: no_valid_reply',
  'run failed: effect_failed',
  'run cancelled: cancelled',
];

const envInt = (name: string): number | undefined => {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : Number(v);
};

describe('whole-system simulation (memory store)', () => {
  it('keeps I1-I15 after every action and drains to rest, under random interleavings, faults and crashes', async () => {
    const seed = envInt('SIM_SEED');
    const path = process.env.SIM_PATH;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(actionArb, { minLength: 1, maxLength: 60, size: 'max' }),
        (batchSize, actions) => simulate(batchSize, actions),
      ),
      {
        numRuns: envInt('SIM_RUNS') ?? 1000,
        ...(seed === undefined ? {} : { seed }),
        ...(path === undefined || path === '' ? {} : { path }),
      },
    );
    if (process.env.SIM_COVERAGE) console.log([...coverage].sort().map(([k, n]) => `${n}\t${k}`).join('\n'));
    // Vacuity guard: the invariants above mean little unless these situations actually occur.
    if (path === undefined || path === '') {
      const missing = REQUIRED_COVERAGE.filter((what) => (coverage.get(what) ?? 0) === 0);
      expect(missing).toEqual([]);
    }
  }, 120_000);
});
