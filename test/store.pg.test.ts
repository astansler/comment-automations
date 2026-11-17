import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StoreConflictError } from '../src/store/errors.js';
import { createPgStore, migrate } from '../src/store/pg.js';
import type { Store } from '../src/store/store.js';
import { aMessage, aRun, anEffect, storeContract } from './store.contract.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('postgres store', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 12 });
  });
  afterAll(async () => {
    await pool.end();
  });

  /** A store in its own new schema, so test files can run in parallel and reruns start clean. */
  async function freshStore(): Promise<{ store: Store; cleanup: () => Promise<void> }> {
    const schema = `store_test_${randomUUID().replaceAll('-', '')}`;
    await migrate(pool, { schema });
    return {
      store: createPgStore(pool, { schema }),
      cleanup: async () => {
        await pool.query(`DROP SCHEMA ${pg.escapeIdentifier(schema)} CASCADE`);
      },
    };
  }

  /** Resolves once some backend is waiting on a lock in this database: proof of blocking without sleeps. */
  async function untilSomeoneIsBlocked(): Promise<void> {
    for (;;) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
      );
      if ((rows[0]?.n ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  storeContract('postgres', freshStore);

  describe('concurrency', () => {
    let store: Store;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ store, cleanup } = await freshStore());
    });
    afterAll(async () => {
      await cleanup();
    });

    it('lockConversation blocks a second transaction on the same conversation until the first commits', async () => {
      const contact = `lock-${randomUUID()}`;
      const trace: string[] = [];
      let firstHasLock!: () => void;
      const locked = new Promise<void>((resolve) => (firstHasLock = resolve));

      const first = store.tx(async (tx) => {
        await tx.lockConversation('acct', contact);
        trace.push('first locked');
        firstHasLock();
        await untilSomeoneIsBlocked();
        trace.push('first commits');
      });
      await locked;
      const second = store.tx(async (tx) => {
        await tx.lockConversation('acct', contact);
        trace.push('second locked');
      });

      await Promise.all([first, second]);
      expect(trace).toEqual(['first locked', 'first commits', 'second locked']);
    });

    it('lockConversation on different conversations does not block', async () => {
      // If the inner transaction blocked on the outer one's lock, this would deadlock and time out.
      const result = await store.tx(async (outer) => {
        await outer.lockConversation('acct', 'contact-a');
        await outer.lockConversation('x:y', 'z');
        return store.tx(async (inner) => {
          await inner.lockConversation('acct', 'contact-b');
          await inner.lockConversation('x', 'y:z'); // would collide with a naive `${a}:${c}` key
          return 'not blocked';
        });
      });
      expect(result).toBe('not blocked');
    });

    it('concurrent claimers claim every due effect exactly once', async () => {
      const prefix = `claim-${randomUUID()}`;
      await store.tx(async (tx) => {
        for (let i = 0; i < 200; i++) {
          await tx.insertEffect(anEffect({ key: `${prefix}-${String(i).padStart(3, '0')}`, nextAttemptAt: i }));
        }
      });

      const claimer = async (): Promise<string[]> => {
        const mine: string[] = [];
        for (;;) {
          const batch = await store.tx((tx) => tx.claimDueEffects(1_000, 10, 60_000));
          if (batch.length === 0) return mine;
          mine.push(...batch.map((c) => c.effect.key));
        }
      };
      const results = await Promise.all(Array.from({ length: 8 }, claimer));

      const all = results.flat();
      expect(all).toHaveLength(200);
      expect(new Set(all).size).toBe(200);
      expect(results.filter((r) => r.length > 0).length).toBeGreaterThan(1);
    });

    it('without the lock, the unique index lets exactly one of two concurrent active runs in', async () => {
      const contact = `race-${randomUUID()}`;
      let firstInserted!: () => void;
      const inserted = new Promise<void>((resolve) => (firstInserted = resolve));

      const first = store.tx(async (tx) => {
        await tx.insertRun(aRun({ id: `${contact}-1`, triggerCommentId: `${contact}-1`, contactId: contact, status: 'running' }));
        firstInserted();
        await untilSomeoneIsBlocked(); // the second insert waits on our uncommitted index entry
      });
      await inserted;
      const second = store.tx((tx) =>
        tx.insertRun(aRun({ id: `${contact}-2`, triggerCommentId: `${contact}-2`, contactId: contact, status: 'running' })),
      );

      const [a, b] = await Promise.allSettled([first, second]);
      expect(a.status).toBe('fulfilled');
      expect(b.status).toBe('rejected');
      const err = (b as PromiseRejectedResult).reason as unknown;
      expect(err).toBeInstanceOf(StoreConflictError);
      expect((err as StoreConflictError).code).toBe('conversation_busy');
      expect((await store.tx((tx) => tx.findActiveRun('acct-1', contact)))?.id).toBe(`${contact}-1`);
    });

    it('a transaction that hits a conflict rolls back completely', async () => {
      const contact = `rollback-${randomUUID()}`;
      await store.tx((tx) => tx.insertRun(aRun({ id: `${contact}-1`, triggerCommentId: `${contact}-1`, contactId: contact })));

      const err = await store
        .tx(async (tx) => {
          await tx.insertMessage(aMessage({ id: `${contact}-msg`, contactId: contact }));
          await tx.insertEffect(anEffect({ key: `${contact}-fx`, contactId: contact }));
          await tx.insertRun(aRun({ id: `${contact}-2`, triggerCommentId: `${contact}-1`, contactId: contact }));
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(StoreConflictError);
      expect((err as StoreConflictError).code).toBe('duplicate_trigger');
      await store.tx(async (tx) => {
        expect(await tx.listUnconsumedMessages('acct-1', contact, 0)).toEqual([]);
        expect(await tx.getEffect(`${contact}-fx`)).toBeNull();
        expect(await tx.getRun(`${contact}-2`)).toBeNull();
      });
    });
  });
});
