import { isActive, SENT_FIRST, type AutomationVersion, type EffectKind, type Millis, type Run } from '../core/types.js';
import { StoreConflictError } from './errors.js';
import type { ClaimedEffect, RunLogEntry, Store, StoredEffect, StoredMessage, Tx } from './store.js';

interface State {
  inboundEvents: Map<string, Millis>;
  /** Insertion order is publication order: the last version of an automation is its latest. */
  versions: Map<string, AutomationVersion>;
  runs: Map<string, Run>;
  messages: Map<string, StoredMessage>;
  effects: Map<string, StoredEffect>;
  throttles: Map<string, Millis>;
  leads: Map<string, Record<string, string>>;
  runLog: RunLogEntry[];
}

export interface MemorySnapshot {
  runs: Run[];
  effects: StoredEffect[];
  messages: StoredMessage[];
  leads: { accountId: string; contactId: string; field: string; value: string }[];
  runLog: RunLogEntry[];
  throttles: { accountId: string; kind: EffectKind; until: Millis }[];
}

const copy = <T>(value: T): T => structuredClone(value);
const conversationKey = (accountId: string, contactId: string): string => JSON.stringify([accountId, contactId]);
/** Code-unit order, matching the `COLLATE "C"` id columns in Postgres. */
const throttleKey = (accountId: string, kind: EffectKind): string => JSON.stringify([accountId, kind]);
const sendRank = (kind: EffectKind): number => (SENT_FIRST.includes(kind) ? 0 : 1);
const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function emptyState(): State {
  return {
    inboundEvents: new Map(),
    versions: new Map(),
    runs: new Map(),
    messages: new Map(),
    effects: new Map(),
    throttles: new Map(),
    leads: new Map(),
    runLog: [],
  };
}

/** Mirrors the two unique indexes on `runs`. */
function checkRunInvariants(s: State, run: Run): void {
  for (const other of s.runs.values()) {
    if (other.id === run.id) continue;
    if (other.accountId === run.accountId && other.triggerCommentId === run.triggerCommentId) {
      throw new StoreConflictError('duplicate_trigger');
    }
    if (
      isActive(run.status) &&
      isActive(other.status) &&
      other.accountId === run.accountId &&
      other.contactId === run.contactId
    ) {
      throw new StoreConflictError('conversation_busy');
    }
  }
}

function openTx(s: State): Tx {
  return {
    async recordInboundEvent(eventId, at) {
      if (s.inboundEvents.has(eventId)) return false;
      s.inboundEvents.set(eventId, at);
      return true;
    },

    async putVersion(version) {
      // Versions are immutable: a repeated put keeps the first row (and its place in the order).
      if (!s.versions.has(version.id)) s.versions.set(version.id, copy(version));
    },
    async getVersion(versionId) {
      const v = s.versions.get(versionId);
      return v ? copy(v) : null;
    },
    async listEnabledVersions(accountId) {
      const latest = new Map<string, AutomationVersion>();
      for (const v of s.versions.values()) if (v.accountId === accountId) latest.set(v.automationId, v);
      return [...latest.values()]
        .filter((v) => v.enabled)
        .sort((a, b) => compareIds(a.automationId, b.automationId))
        .map(copy);
    },

    // Transactions already run one at a time, so the conversation lock is implied.
    async lockConversation() {},
    async getRun(runId) {
      const r = s.runs.get(runId);
      return r ? copy(r) : null;
    },
    async findRunByComment(accountId, commentId) {
      for (const r of s.runs.values()) {
        if (r.accountId === accountId && r.triggerCommentId === commentId) return copy(r);
      }
      return null;
    },
    async findActiveRun(accountId, contactId) {
      for (const r of s.runs.values()) {
        if (r.accountId === accountId && r.contactId === contactId && isActive(r.status)) return copy(r);
      }
      return null;
    },
    async findOldestQueuedRun(accountId, contactId) {
      const queued = [...s.runs.values()]
        .filter((r) => r.accountId === accountId && r.contactId === contactId && r.status === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt || compareIds(a.id, b.id));
      return queued[0] ? copy(queued[0]) : null;
    },
    async hasRunSince(automationId, contactId, since) {
      for (const r of s.runs.values()) {
        if (r.automationId === automationId && r.contactId === contactId && r.createdAt >= since) return true;
      }
      return false;
    },
    async insertRun(run) {
      if (s.runs.has(run.id)) throw new Error(`run ${run.id} already exists`);
      checkRunInvariants(s, run);
      s.runs.set(run.id, copy(run));
    },
    async updateRun(run) {
      if (!s.runs.has(run.id)) throw new Error(`run ${run.id} not found`);
      checkRunInvariants(s, run);
      s.runs.set(run.id, copy(run));
    },
    async listDueTimers(now, limit) {
      return [...s.runs.values()]
        .filter((r) => r.status === 'waiting_reply' && r.wakeAt !== null && r.wakeAt <= now)
        .sort((a, b) => (a.wakeAt ?? 0) - (b.wakeAt ?? 0) || compareIds(a.id, b.id))
        .slice(0, limit)
        .map((r) => r.id);
    },

    async insertMessage(message) {
      if (s.messages.has(message.id)) return false;
      s.messages.set(message.id, copy(message));
      return true;
    },
    async listUnconsumedMessages(accountId, contactId, since) {
      return [...s.messages.values()]
        .filter(
          (m) =>
            m.accountId === accountId &&
            m.contactId === contactId &&
            m.consumedByRunId === null &&
            m.receivedAt >= since,
        )
        .sort((a, b) => a.receivedAt - b.receivedAt || compareIds(a.id, b.id))
        .map(copy);
    },
    async markMessageConsumed(messageId, runId) {
      const m = s.messages.get(messageId);
      if (!m) throw new Error(`message ${messageId} not found`);
      m.consumedByRunId = runId;
    },

    async insertEffect(effect) {
      if (!s.effects.has(effect.key)) s.effects.set(effect.key, copy(effect));
    },
    async getEffect(key) {
      const e = s.effects.get(key);
      return e ? copy(e) : null;
    },
    async updateEffect(effect) {
      if (!s.effects.has(effect.key)) throw new Error(`effect ${effect.key} not found`);
      s.effects.set(effect.key, copy(effect));
    },
    async claimDueEffects(now, limit, leaseMs) {
      const throttled = (e: StoredEffect) => (s.throttles.get(throttleKey(e.accountId, e.kind)) ?? -Infinity) > now;
      const due = [...s.effects.values()]
        .filter(
          (e) =>
            ((e.status === 'pending' && e.nextAttemptAt <= now) ||
              (e.status === 'sending' && e.leaseUntil !== null && e.leaseUntil <= now)) &&
            !throttled(e),
        )
        .sort((a, b) => sendRank(a.kind) - sendRank(b.kind) || a.nextAttemptAt - b.nextAttemptAt || compareIds(a.key, b.key))
        .slice(0, limit);
      return due.map((e): ClaimedEffect => {
        const wasInFlight = e.status === 'sending';
        e.status = 'sending';
        e.attempts += 1;
        e.leaseUntil = now + leaseMs;
        e.updatedAt = now;
        return { effect: copy(e), wasInFlight };
      });
    },

    async setAccountThrottle(accountId, kind, until) {
      const key = throttleKey(accountId, kind);
      s.throttles.set(key, Math.max(s.throttles.get(key) ?? -Infinity, until));
    },
    async getAccountThrottle(accountId, kind) {
      return s.throttles.get(throttleKey(accountId, kind)) ?? null;
    },

    async upsertLead(accountId, contactId, field, value) {
      const key = conversationKey(accountId, contactId);
      s.leads.set(key, { ...s.leads.get(key), [field]: value });
    },
    async getLeadFields(accountId, contactId) {
      return { ...s.leads.get(conversationKey(accountId, contactId)) };
    },
    async appendRunLog(runId, at, entry) {
      s.runLog.push({ runId, at, entry });
    },
    async listRunLog(runId) {
      return s.runLog.filter((e) => e.runId === runId).map(copy);
    },
  };
}

export function createMemoryStore(): Store & { snapshot(): MemorySnapshot } {
  let state = emptyState();
  let tail: Promise<unknown> = Promise.resolve();

  return {
    tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      // FIFO mutex: each transaction starts when the previous one settles. It
      // works on a draft that replaces the state only on success, so a throw
      // discards every change.
      const result = tail.then(async () => {
        const draft = copy(state);
        const value = await fn(openTx(draft));
        state = draft;
        return value;
      });
      tail = result.catch(() => {});
      return result;
    },
    snapshot() {
      return copy({
        runs: [...state.runs.values()],
        effects: [...state.effects.values()],
        messages: [...state.messages.values()],
        leads: [...state.leads].flatMap(([key, fields]) => {
          const [accountId, contactId] = JSON.parse(key) as [string, string];
          return Object.entries(fields).map(([field, value]) => ({ accountId, contactId, field, value }));
        }),
        runLog: state.runLog,
        throttles: [...state.throttles].map(([key, until]) => {
          const [accountId, kind] = JSON.parse(key) as [string, EffectKind];
          return { accountId, kind, until };
        }),
      });
    },
  };
}
