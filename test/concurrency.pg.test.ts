/**
 * Real Postgres, real concurrency: several runtimes (= worker processes)
 * sharing one pg store tick in concurrent loops while webhooks, duplicate
 * webhooks and replies arrive concurrently. The fake platform is made
 * genuinely async (a random 0-5 ms delay around each send) so workers
 * interleave at the network call, which is where the crash windows are.
 *
 * Each test gets its own schema, dropped afterwards.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AskStep, AutomationDefinition, Millis } from '../src/core/types.js';
import type { PlatformAdapter } from '../src/runtime/adapter.js';
import { createRuntime, isIdle, type Runtime, type RuntimeConfig } from '../src/runtime/runtime.js';
import { createPgStore, migrate } from '../src/store/pg.js';
import type { Store } from '../src/store/store.js';
import { createClock, createFakePlatform, createIds, type FakePlatform } from './support/fakePlatform.js';

const DATABASE_URL = process.env.DATABASE_URL;

const ACCOUNT = 'acct-1';
const TEXT = {
  reply: 'Sent you a DM!',
  pricingPrompt: 'Pricing: what is your email?',
  pricingLink: 'Pricing link for {{email}}',
  demoPrompt: 'Demo: what is your email?',
  demoLink: 'Demo link for {{email}}',
};
const ask = (o: Partial<AskStep>): AskStep => ({
  type: 'ask',
  prompt: TEXT.pricingPrompt,
  capture: 'email',
  saveAs: 'email',
  timeoutSeconds: 82_800,
  maxAttempts: 2,
  repromptText: 'That was not an email. Again?',
  ...o,
});
const trigger = (keyword: string): AutomationDefinition['trigger'] => ({
  type: 'comment_keyword',
  platform: 'instagram',
  keywords: [keyword],
  match: 'contains',
  postIds: 'any',
});
const PRICING: AutomationDefinition = {
  trigger: trigger('pricing'),
  steps: [
    { type: 'reply_to_comment', text: TEXT.reply },
    ask({ prompt: TEXT.pricingPrompt, skipIfKnown: true }),
    { type: 'send_dm', text: TEXT.pricingLink },
  ],
};
const DEMO: AutomationDefinition = {
  trigger: trigger('demo'),
  steps: [ask({ prompt: TEXT.demoPrompt }), { type: 'send_dm', text: TEXT.demoLink }],
};
const PROMPTS = new Set([TEXT.pricingPrompt, TEXT.demoPrompt]);

const shuffle = <T>(items: T[]): T[] => {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};
const jitter = (): Promise<void> => sleep(Math.floor(Math.random() * 6));
const emailOf = (contactId: string): string => `${contactId}@example.com`;

interface RunRow {
  id: string;
  automation_id: string;
  contact_id: string;
  trigger_comment_id: string;
  status: string;
  started_at: string | null;
}
interface EffectRow {
  key: string;
  run_id: string;
  kind: string;
  status: string;
  text: string;
  contact_id: string;
}
interface MessageRow {
  id: string;
  contact_id: string;
  consumed_by_run_id: string | null;
}

/** The fake platform, made async, recording every refusal it gives. */
function asyncPlatform(): { platform: FakePlatform; adapter: PlatformAdapter; refusals: string[]; maxInFlight: () => number } {
  const platform = createFakePlatform();
  const refusals: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const adapter: PlatformAdapter = {
    async send(effect) {
      peak = Math.max(peak, ++inFlight);
      try {
        await jitter();
        const result = await platform.send(effect);
        if (!result.ok) refusals.push(`${effect.key}: ${JSON.stringify(result.error)}`);
        await jitter();
        return result;
      } finally {
        inFlight--;
      }
    },
    reconcile: (effect) => platform.reconcile(effect),
  };
  return { platform, adapter, refusals, maxInFlight: () => peak };
}

describe.skipIf(!DATABASE_URL)('postgres: real concurrency', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 16 });
  });
  afterAll(async () => {
    await pool.end();
  });

  async function freshSchema(): Promise<{ store: Store; q: <R extends pg.QueryResultRow>(sql: string) => Promise<R[]>; cleanup: () => Promise<void> }> {
    const schema = `concurrency_test_${randomUUID().replaceAll('-', '')}`;
    await migrate(pool, { schema });
    const qualified = pg.escapeIdentifier(schema);
    return {
      store: createPgStore(pool, { schema }),
      q: async <R extends pg.QueryResultRow>(sql: string) => (await pool.query<R>(sql.replaceAll('$schema', qualified))).rows,
      cleanup: async () => {
        await pool.query(`DROP SCHEMA ${qualified} CASCADE`);
      },
    };
  }

  /**
   * `n` workers sharing the store, each ticking in its own loop until stopped.
   * Every rejection anywhere is collected: the tests assert there are none.
   */
  function workers(n: number, deps: { store: Store; adapter: PlatformAdapter; now: () => Millis }, config: Partial<RuntimeConfig>) {
    const errors: unknown[] = [];
    let stopped = false;
    const newId = createIds(`w-${randomUUID().slice(0, 8)}`);
    const runtimes: Runtime[] = Array.from({ length: n }, () => createRuntime({ ...deps, newId, config }));
    const loops = runtimes.map(async (rt) => {
      while (!stopped) {
        try {
          if (isIdle(await rt.tick())) await sleep(2);
        } catch (err) {
          errors.push(err);
        }
      }
    });
    return {
      runtimes,
      errors,
      async stop() {
        stopped = true;
        await Promise.all(loops);
      },
    };
  }

  /** Polls until `done()` holds, failing loudly after `ms`. */
  async function until(done: () => Promise<boolean>, ms = 25_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error('not quiescent in time');
      await sleep(20);
    }
  }

  /**
   * Wires the contact's behaviour: whenever a question reaches the platform, the
   * contact answers with their email, and the webhook for that answer is
   * delivered twice, concurrently, with the same event id.
   */
  function answerEveryQuestion(platform: FakePlatform, runtime: Runtime, errors: unknown[], now: () => Millis) {
    const inFlight = new Set<Promise<unknown>>();
    let n = 0;
    platform.onDelivered(async (d) => {
      if (!PROMPTS.has(d.text)) return;
      const eventId = `reply-${d.contactId}-${++n}`;
      platform.contactMessaged(d.accountId, d.contactId);
      const message = { eventId, accountId: d.accountId, contactId: d.contactId, text: `sure, ${emailOf(d.contactId)}`, at: now() };
      const both = Promise.all([runtime.ingestMessage(message), runtime.ingestMessage(message)]).catch((err: unknown) => {
        errors.push(err);
      });
      inFlight.add(both);
      void both.finally(() => inFlight.delete(both));
    });
    return { settled: () => inFlight.size === 0 };
  }

  async function publish(runtime: Runtime): Promise<void> {
    for (const [name, definition] of [
      ['pricing', PRICING],
      ['demo', DEMO],
    ] as const) {
      const r = await runtime.publishVersion({ id: `${name}-v1`, automationId: name, accountId: ACCOUNT, enabled: true, cooldownSeconds: 0, definition });
      expect(r).toEqual({ status: 'published' });
    }
  }

  const quiescent = (q: <R extends pg.QueryResultRow>(sql: string) => Promise<R[]>) => async (): Promise<boolean> => {
    const [row] = await q<{ busy: number }>(
      `SELECT (SELECT count(*) FROM $schema.runs WHERE status NOT IN ('completed', 'failed', 'expired', 'cancelled'))
            + (SELECT count(*) FROM $schema.effects WHERE status IN ('pending', 'sending')) AS busy`,
    );
    return Number(row!.busy) === 0;
  };

  it('storm: 200 shuffled comment webhooks with concurrent duplicates, 4 workers, duplicated replies: every run completes, every send exactly once', async () => {
    const { store, q, cleanup } = await freshSchema();
    try {
      const { platform, adapter, refusals, maxInFlight } = asyncPlatform();
      const now = Date.now;
      const crew = workers(4, { store, adapter, now }, { leaseMs: 10 * 60_000, batchSize: 5 });
      const ingest = crew.runtimes[0]!;
      await publish(ingest);
      const replies = answerEveryQuestion(platform, ingest, crew.errors, now);

      // 40 contacts, 140 distinct comments; 30 redeliveries of the same event and 30 new
      // events for an existing comment. Duplicates are fired in the same Promise.all.
      const contacts = Array.from({ length: 40 }, (_, i) => `contact-${String(i).padStart(2, '0')}`);
      const texts = ['pricing please', 'demo?', 'pricing and a demo'];
      const comments = Array.from({ length: 140 }, (_, i) => ({
        eventId: `evt-${i}`,
        accountId: ACCOUNT,
        commentId: `cmt-${i}`,
        postId: 'post-1',
        authorId: contacts[i % contacts.length]!,
        text: texts[i % texts.length]!,
        at: now(),
      }));
      const redeliveries = comments.slice(0, 30);
      const newEvents = comments.slice(30, 60).map((c) => ({ ...c, eventId: `${c.eventId}-again` }));
      const webhooks = shuffle([...comments, ...redeliveries, ...newEvents]);
      expect(webhooks).toHaveLength(200);

      const results = await Promise.allSettled(webhooks.map((c) => ingest.ingestComment(c)));
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toEqual([]);

      await until(async () => replies.settled() && (await quiescent(q)()));
      await crew.stop();
      expect(crew.errors).toEqual([]);

      const runs = await q<RunRow>('SELECT id, automation_id, contact_id, trigger_comment_id, status, started_at FROM $schema.runs');
      const effects = await q<EffectRow>('SELECT key, run_id, kind, status, text, contact_id FROM $schema.effects');
      const messages = await q<MessageRow>('SELECT id, contact_id, consumed_by_run_id FROM $schema.messages');

      // One run per comment (and so per (automation, comment)); every run completed.
      expect(runs).toHaveLength(140);
      expect(new Set(runs.map((r) => r.trigger_comment_id)).size).toBe(140);
      expect(runs.filter((r) => r.status !== 'completed')).toEqual([]);

      // No faults, so every effect is sent and every key reached the platform exactly once,
      // direct_message included.
      expect(effects.filter((e) => e.status !== 'sent')).toEqual([]);
      const perKey = new Map<string, number>();
      for (const d of platform.deliveries) perKey.set(d.key, (perKey.get(d.key) ?? 0) + 1);
      expect([...perKey].filter(([, n]) => n !== 1)).toEqual([]);
      expect(new Set(perKey.keys())).toEqual(new Set(effects.map((e) => e.key)));
      expect(refusals).toEqual([]); // no window_closed, no already_sent
      expect(maxInFlight()).toBeGreaterThan(1); // the workers really overlapped at the platform

      // skipIfKnown under concurrency: a contact's runs are serialised, so the pricing
      // question goes to a contact at most once, and only from a run that started before
      // that contact's email was first captured.
      const firstCapture = new Map<string, number>();
      for (const row of await q<{ contact_id: string; at: string }>(
        `SELECT r.contact_id, min(l.at) AS at FROM $schema.run_log l JOIN $schema.runs r ON r.id = l.run_id
         WHERE l.entry = 'captured email' GROUP BY r.contact_id`,
      )) {
        firstCapture.set(row.contact_id, Number(row.at));
      }
      const runsById = new Map(runs.map((r) => [r.id, r]));
      const pricingAsks = new Map<string, number>();
      for (const e of effects) {
        if (e.text !== TEXT.pricingPrompt) continue;
        pricingAsks.set(e.contact_id, (pricingAsks.get(e.contact_id) ?? 0) + 1);
        const run = runsById.get(e.run_id)!;
        expect(Number(run.started_at)).toBeLessThanOrEqual(firstCapture.get(e.contact_id)!);
      }
      expect([...pricingAsks].filter(([, n]) => n > 1)).toEqual([]);

      // Each reply webhook stored once (duplicates dropped), consumed at most once, by a run
      // of its own conversation; exactly one consumed reply per question asked.
      const prompts = effects.filter((e) => PROMPTS.has(e.text));
      expect(messages).toHaveLength(prompts.length);
      for (const m of messages) {
        expect(m.consumed_by_run_id).not.toBeNull();
        expect(runsById.get(m.consumed_by_run_id!)!.contact_id).toBe(m.contact_id);
      }
      expect(new Set(messages.map((m) => m.consumed_by_run_id)).size).toBe(prompts.length);
    } finally {
      await cleanup();
    }
  });

  it('same-conversation hammer: 30 comments and 10 messages from one contact at once, 4 workers: its runs execute strictly one after another', async () => {
    const { store, q, cleanup } = await freshSchema();
    try {
      const { platform, adapter, refusals } = asyncPlatform();
      const now = Date.now;
      const crew = workers(4, { store, adapter, now }, { leaseMs: 10 * 60_000, batchSize: 5 });
      const ingest = crew.runtimes[0]!;
      await publish(ingest);
      const replies = answerEveryQuestion(platform, ingest, crew.errors, now);

      const contact = 'hammered';
      const comments = Array.from({ length: 30 }, (_, i) =>
        ingest.ingestComment({ eventId: `evt-${i}`, accountId: ACCOUNT, commentId: `cmt-${i}`, postId: 'post-1', authorId: contact, text: i % 2 === 0 ? 'pricing' : 'demo', at: now() }),
      );
      const messages = Array.from({ length: 10 }, (_, i) => {
        platform.contactMessaged(ACCOUNT, contact);
        return ingest.ingestMessage({ eventId: `early-${i}`, accountId: ACCOUNT, contactId: contact, text: `hello ${i}`, at: now() });
      });
      const results = await Promise.allSettled(shuffle([...comments, ...messages]));
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

      await until(async () => replies.settled() && (await quiescent(q)()));
      await crew.stop();
      expect(crew.errors).toEqual([]);
      expect(refusals).toEqual([]);

      const runs = await q<RunRow>('SELECT id, automation_id, contact_id, trigger_comment_id, status, started_at FROM $schema.runs');
      expect(runs).toHaveLength(30);
      expect(runs.filter((r) => r.status !== 'completed')).toEqual([]);

      // Deliveries of two runs never interleave: each run's deliveries form one contiguous
      // block in the platform's log, so run A's last delivery precedes run B's first.
      const order = platform.deliveries.map((d) => d.key.split(':')[0]!);
      const blocks = order.filter((runId, i) => i === 0 || order[i - 1] !== runId);
      expect(new Set(blocks).size).toBe(blocks.length);
      expect(new Set(blocks)).toEqual(new Set(runs.map((r) => r.id)));
      // And the blocks come in the order the runs became active.
      const startedAt = new Map(runs.map((r) => [r.id, Number(r.started_at)]));
      const starts = blocks.map((id) => startedAt.get(id)!);
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
    } finally {
      await cleanup();
    }
  });

  it('reply vs timer on a real database: deadline passed, reply and worker tick fired together, every run ends exactly one way', async () => {
    const { store, q, cleanup } = await freshSchema();
    try {
      const { platform, adapter } = asyncPlatform();
      const clock = createClock(1_750_000_000_000);
      const config = { leaseMs: 10 * 60_000, batchSize: 50 };
      const newId = createIds('run');
      const runtimes = Array.from({ length: 4 }, () => createRuntime({ store, adapter, now: clock.now, newId, config }));
      const rt = runtimes[0]!;
      const definition: AutomationDefinition = {
        trigger: trigger('pricing'),
        steps: [ask({ prompt: TEXT.pricingPrompt, timeoutSeconds: 60 }), { type: 'send_dm', text: TEXT.pricingLink }],
      };
      expect(await rt.publishVersion({ id: 'p-v1', automationId: 'p', accountId: ACCOUNT, enabled: true, cooldownSeconds: 0, definition })).toEqual({ status: 'published' });

      const N = 40;
      const contacts = Array.from({ length: N }, (_, i) => `racer-${String(i).padStart(2, '0')}`);
      await Promise.all(contacts.map((c, i) => rt.ingestComment({ eventId: `e-${i}`, accountId: ACCOUNT, commentId: `c-${i}`, postId: 'p', authorId: c, text: 'pricing', at: clock.now() })));
      for (let i = 0; i < 20 && !isIdle(await rt.tick()); i++);
      const waiting = await q<{ n: number }>(`SELECT count(*)::int AS n FROM $schema.runs WHERE status = 'waiting_reply'`);
      expect(waiting[0]!.n).toBe(N);

      clock.advance(60_000); // exactly at the deadline: the timer is due and a reply is still valid
      const results = await Promise.allSettled(
        contacts.flatMap((c, i) => {
          platform.contactMessaged(ACCOUNT, c);
          // A tick needs three round trips (claim, list timers, lock) to a reply's one, so the
          // replies start 0-100 ms late: some land before the timer, some after.
          const reply = sleep(Math.random() * 100).then(() =>
            rt.ingestMessage({ eventId: `m-${i}`, accountId: ACCOUNT, contactId: c, text: emailOf(c), at: clock.now() }),
          );
          const tick = runtimes[i % runtimes.length]!.tick();
          return [reply, tick];
        }),
      );
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      for (let i = 0; i < 20 && !isIdle(await rt.tick()); i++);

      const runs = await q<RunRow>('SELECT id, automation_id, contact_id, trigger_comment_id, status, started_at FROM $schema.runs');
      const messages = await q<MessageRow>('SELECT id, contact_id, consumed_by_run_id FROM $schema.messages');
      const links = (runId: string) => platform.deliveries.filter((d) => d.key.startsWith(`${runId}:1:`));
      const tally = { completed: 0, expired: 0 };
      for (const run of runs) {
        const message = messages.find((m) => m.contact_id === run.contact_id)!;
        if (run.status === 'completed') {
          tally.completed++;
          expect(links(run.id)).toHaveLength(1);
          expect(message.consumed_by_run_id).toBe(run.id);
        } else {
          expect(run.status).toBe('expired');
          tally.expired++;
          expect(links(run.id)).toHaveLength(0);
          expect(message.consumed_by_run_id).toBeNull();
        }
      }
      expect(tally.completed + tally.expired).toBe(N);
      // The race was really run: both sides won somewhere.
      expect(tally.completed).toBeGreaterThan(0);
      expect(tally.expired).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });
});
