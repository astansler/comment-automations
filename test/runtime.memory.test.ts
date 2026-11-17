import { describe, expect, it, vi } from 'vitest';
import { createRuntime, runWorker } from '../src/runtime/runtime.js';
import { createMemoryStore } from '../src/store/memory.js';
import { runtimeScenarios } from './runtime.scenarios.js';
import { createClock, createFakePlatform, createIds } from './support/fakePlatform.js';

runtimeScenarios('memory', async () => ({ store: createMemoryStore(), cleanup: async () => {} }));

describe('runWorker', () => {
  it('works through due effects and stops when the signal aborts', async () => {
    const store = createMemoryStore();
    const platform = createFakePlatform();
    const runtime = createRuntime({ store, adapter: platform, now: createClock(0).now, newId: createIds('run') });
    await runtime.publishVersion({
      id: 'v1',
      automationId: 'a',
      accountId: 'acct',
      enabled: true,
      cooldownSeconds: 0,
      definition: {
        trigger: { type: 'comment_keyword', platform: 'instagram', keywords: ['hi'], match: 'contains', postIds: 'any' },
        steps: [{ type: 'reply_to_comment', text: 'hello' }],
      },
    });
    await runtime.ingestComment({ eventId: 'e', accountId: 'acct', commentId: 'c', postId: 'p', authorId: 'u', text: 'hi', at: 0 });

    const controller = new AbortController();
    const worker = runWorker(runtime, { intervalMs: 5, signal: controller.signal });
    await vi.waitFor(() => expect(platform.deliveries).toHaveLength(1));
    controller.abort();

    await expect(worker).resolves.toBeUndefined();
    expect(store.snapshot().runs[0]).toMatchObject({ status: 'completed' });
  });
});
