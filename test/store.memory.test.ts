import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../src/store/memory.js';
import { aRun, storeContract } from './store.contract.js';

storeContract('memory', async () => ({ store: createMemoryStore(), cleanup: async () => {} }));

describe('memory store', () => {
  it('runs concurrent transactions one at a time, in call order', async () => {
    const store = createMemoryStore();
    const trace: string[] = [];
    // Read-modify-write with a yield in the middle: interleaving would lose an increment.
    const increment = (name: string) =>
      store.tx(async (tx) => {
        trace.push(`${name} start`);
        const n = Number((await tx.getLeadFields('a', 'c')).n ?? '0');
        await sleep(5);
        await tx.upsertLead('a', 'c', 'n', String(n + 1), 0);
        trace.push(`${name} end`);
      });

    await Promise.all([increment('t1'), increment('t2'), increment('t3')]);

    expect(trace).toEqual(['t1 start', 't1 end', 't2 start', 't2 end', 't3 start', 't3 end']);
    expect(await store.tx((tx) => tx.getLeadFields('a', 'c'))).toEqual({ n: '3' });
  });

  it('a failed transaction does not block the queue', async () => {
    const store = createMemoryStore();
    const failed = store.tx(async () => {
      await sleep(1);
      throw new Error('boom');
    });
    const next = store.tx(async (tx) => {
      await tx.insertRun(aRun());
      return 'ok';
    });
    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('ok');
    expect(store.snapshot().runs.map((r) => r.id)).toEqual(['run-1']);
  });

  it('snapshot is a copy', async () => {
    const store = createMemoryStore();
    await store.tx((tx) => tx.insertRun(aRun()));
    store.snapshot().runs[0]!.status = 'running';
    expect(store.snapshot().runs[0]!.status).toBe('queued');
  });
});
