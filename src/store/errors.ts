export type StoreConflictCode = 'duplicate_trigger' | 'conversation_busy';

/** A write would break a store invariant. Both stores throw it; callers branch on `code`. */
export class StoreConflictError extends Error {
  override readonly name = 'StoreConflictError';
  readonly code: StoreConflictCode;

  constructor(code: StoreConflictCode, options?: ErrorOptions) {
    super(`store conflict: ${code}`, options);
    this.code = code;
  }
}
