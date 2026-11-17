/**
 * Crash injection at the storage boundary. Wraps a Store so a test can arm
 * "the Nth transaction from now dies":
 *
 * - `before`: the transaction never runs; nothing is committed (the process
 *   died before or during it, so it rolled back).
 * - `after`: the transaction runs and commits, then the call rejects. The
 *   caller never learns that it committed: a lost acknowledgement, or a
 *   process that died right after COMMIT.
 *
 * Either way the caller sees a CrashError and, like a dead process, does no
 * further work on that call path.
 */
import type { Store, Tx } from '../../src/store/store.js';

export class CrashError extends Error {
  constructor(readonly mode: CrashMode) {
    super(`injected crash (${mode} commit)`);
  }
}

export type CrashMode = 'before' | 'after';

export interface FaultyStore extends Store {
  /** The transaction `nth` calls from now (0 = the very next one) crashes. Replaces any armed crash. */
  arm(mode: CrashMode, nth?: number): void;
  disarm(): void;
  readonly armed: boolean;
  /** Called after every transaction that committed (including `after` crashes), before the caller resumes. */
  onCommit(listener: () => void): void;
}

export function createFaultyStore(inner: Store): FaultyStore {
  let armed: { mode: CrashMode; countdown: number } | null = null;
  let committed: () => void = () => {};

  return {
    tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      if (armed !== null && armed.countdown-- === 0) {
        const { mode } = armed;
        armed = null;
        if (mode === 'before') return Promise.reject(new CrashError('before'));
        return inner.tx(fn).then(() => {
          committed();
          throw new CrashError('after');
        });
      }
      return inner.tx(fn).then((value) => {
        committed();
        return value;
      });
    },
    onCommit(listener) {
      committed = listener;
    },
    arm(mode, nth = 0) {
      armed = { mode, countdown: nth };
    },
    disarm() {
      armed = null;
    },
    get armed() {
      return armed !== null;
    },
  };
}
