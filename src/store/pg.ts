import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { SENT_FIRST, type AutomationDefinition, type AutomationVersion, type Run } from '../core/types.js';
import { StoreConflictError, type StoreConflictCode } from './errors.js';
import type { ClaimedEffect, RunLogEntry, Store, StoredEffect, StoredMessage, Tx } from './store.js';

export interface PgStoreOptions {
  /** Schema holding the tables; defaults to the connection's search_path. */
  schema?: string;
}

/** Applies schema.sql inside `opts.schema` (created if missing). Not re-runnable on an existing schema. */
export async function migrate(pool: pg.Pool, opts: PgStoreOptions = {}): Promise<void> {
  const ddl = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (opts.schema !== undefined) {
      const schema = client.escapeIdentifier(opts.schema);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
    }
    await client.query(ddl);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function createPgStore(pool: pg.Pool, opts: PgStoreOptions = {}): Store {
  return {
    async tx(fn) {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query('BEGIN');
        if (opts.schema !== undefined) {
          await client.query(`SET LOCAL search_path TO ${client.escapeIdentifier(opts.schema)}`);
        }
        const value = await fn(openTx(client));
        await client.query('COMMIT');
        return value;
      } catch (err) {
        await client.query('ROLLBACK').catch((rollbackErr: Error) => {
          broken = rollbackErr; // the connection is unusable; release(err) destroys it
        });
        throw err;
      } finally {
        client.release(broken);
      }
    },
  };
}

// -- rows and mappers ----------------------------------------------------------
// bigint columns arrive as strings. They are converted here rather than with a
// global pg type parser, which would change behaviour for every other pg user.

type BigintText = string;

const millisOrNull = (v: BigintText | null): number | null => (v === null ? null : Number(v));

interface VersionRow {
  id: string;
  automation_id: string;
  account_id: string;
  enabled: boolean;
  cooldown_seconds: number;
  definition: AutomationDefinition;
}
const VERSION_COLUMNS = 'id, automation_id, account_id, enabled, cooldown_seconds, definition';
const toVersion = (r: VersionRow): AutomationVersion => ({
  id: r.id,
  automationId: r.automation_id,
  accountId: r.account_id,
  enabled: r.enabled,
  cooldownSeconds: r.cooldown_seconds,
  definition: r.definition,
});

interface RunRow {
  id: string;
  automation_id: string;
  version_id: string;
  account_id: string;
  contact_id: string;
  trigger_comment_id: string;
  status: Run['status'];
  step_index: number;
  attempt: number;
  context: Record<string, string>;
  window_open: boolean;
  pending_effect_key: string | null;
  wake_at: BigintText | null;
  outcome: string | null;
  created_at: BigintText;
  started_at: BigintText | null;
  updated_at: BigintText;
}
const RUN_COLUMNS =
  'id, automation_id, version_id, account_id, contact_id, trigger_comment_id, status, step_index, attempt, ' +
  'context, window_open, pending_effect_key, wake_at, outcome, created_at, started_at, updated_at';
const toRun = (r: RunRow): Run => ({
  id: r.id,
  automationId: r.automation_id,
  versionId: r.version_id,
  accountId: r.account_id,
  contactId: r.contact_id,
  triggerCommentId: r.trigger_comment_id,
  status: r.status,
  stepIndex: r.step_index,
  attempt: r.attempt,
  context: r.context,
  windowOpen: r.window_open,
  pendingEffectKey: r.pending_effect_key,
  wakeAt: millisOrNull(r.wake_at),
  outcome: r.outcome,
  createdAt: Number(r.created_at),
  startedAt: millisOrNull(r.started_at),
  updatedAt: Number(r.updated_at),
});
/** Parameters in RUN_COLUMNS order. */
const runParams = (r: Run): unknown[] => [
  r.id,
  r.automationId,
  r.versionId,
  r.accountId,
  r.contactId,
  r.triggerCommentId,
  r.status,
  r.stepIndex,
  r.attempt,
  JSON.stringify(r.context),
  r.windowOpen,
  r.pendingEffectKey,
  r.wakeAt,
  r.outcome,
  r.createdAt,
  r.startedAt,
  r.updatedAt,
];

interface MessageRow {
  id: string;
  account_id: string;
  contact_id: string;
  text: string;
  received_at: BigintText;
  consumed_by_run_id: string | null;
}
const MESSAGE_COLUMNS = 'id, account_id, contact_id, text, received_at, consumed_by_run_id';
const toMessage = (r: MessageRow): StoredMessage => ({
  id: r.id,
  accountId: r.account_id,
  contactId: r.contact_id,
  text: r.text,
  receivedAt: Number(r.received_at),
  consumedByRunId: r.consumed_by_run_id,
});

interface EffectRow {
  key: string;
  run_id: string;
  account_id: string;
  contact_id: string;
  comment_id: string;
  kind: StoredEffect['kind'];
  policy: StoredEffect['policy'];
  text: string;
  status: StoredEffect['status'];
  attempts: number;
  next_attempt_at: BigintText;
  lease_until: BigintText | null;
  provider_id: string | null;
  last_error: string | null;
  created_at: BigintText;
  updated_at: BigintText;
}
const EFFECT_COLUMNS =
  'key, run_id, account_id, contact_id, comment_id, kind, policy, text, status, attempts, ' +
  'next_attempt_at, lease_until, provider_id, last_error, created_at, updated_at';
const toEffect = (r: EffectRow): StoredEffect => ({
  key: r.key,
  runId: r.run_id,
  accountId: r.account_id,
  contactId: r.contact_id,
  commentId: r.comment_id,
  kind: r.kind,
  policy: r.policy,
  text: r.text,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: Number(r.next_attempt_at),
  leaseUntil: millisOrNull(r.lease_until),
  providerId: r.provider_id,
  lastError: r.last_error,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});
/** Parameters in EFFECT_COLUMNS order. */
const effectParams = (e: StoredEffect): unknown[] => [
  e.key,
  e.runId,
  e.accountId,
  e.contactId,
  e.commentId,
  e.kind,
  e.policy,
  e.text,
  e.status,
  e.attempts,
  e.nextAttemptAt,
  e.leaseUntil,
  e.providerId,
  e.lastError,
  e.createdAt,
  e.updatedAt,
];

interface RunLogRow {
  run_id: string;
  at: BigintText;
  entry: string;
}
const toRunLogEntry = (r: RunLogRow): RunLogEntry => ({ runId: r.run_id, at: Number(r.at), entry: r.entry });

// -- queries ---------------------------------------------------------------------

/** `$1, $2, ..., $n` */
const placeholders = (n: number): string => Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ');
/** `b = $2, c = $3, ...` for every column after the first (the key). */
const assignments = (columns: string): string =>
  columns
    .split(', ')
    .slice(1)
    .map((c, i) => `${c} = $${i + 2}`)
    .join(', ');

const RUN_CONFLICTS: Record<string, StoreConflictCode> = {
  runs_trigger_unique: 'duplicate_trigger',
  runs_one_active_per_conversation: 'conversation_busy',
};

function openTx(client: pg.PoolClient): Tx {
  async function one<R extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<R | null> {
    const { rows } = await client.query<R>(sql, params);
    return rows[0] ?? null;
  }

  async function updateOne(what: string, sql: string, params: unknown[]): Promise<void> {
    const { rowCount } = await client.query(sql, params);
    if (rowCount === 0) throw new Error(`${what} not found`);
  }

  /**
   * Maps unique violations on the run invariants to StoreConflictError. The
   * failed statement aborts the Postgres transaction, so the caller's tx can
   * only roll back; that is the intended use.
   */
  async function writeRun(sql: string, run: Run): Promise<pg.QueryResult> {
    try {
      return await client.query(sql, runParams(run));
    } catch (err) {
      const code =
        err instanceof pg.DatabaseError && err.code === '23505' && err.constraint !== undefined
          ? RUN_CONFLICTS[err.constraint]
          : undefined;
      if (code !== undefined) throw new StoreConflictError(code, { cause: err });
      throw err;
    }
  }

  return {
    async recordInboundEvent(eventId, at) {
      const { rowCount } = await client.query(
        'INSERT INTO inbound_events (event_id, received_at) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [eventId, at],
      );
      return rowCount === 1;
    },

    async putVersion(v) {
      // Versions are immutable: a repeated put keeps the first row.
      await client.query(
        `INSERT INTO automation_versions (${VERSION_COLUMNS}) VALUES (${placeholders(6)}) ON CONFLICT DO NOTHING`,
        [v.id, v.automationId, v.accountId, v.enabled, v.cooldownSeconds, JSON.stringify(v.definition)],
      );
    },
    async getVersion(versionId) {
      const row = await one<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM automation_versions WHERE id = $1`, [
        versionId,
      ]);
      return row && toVersion(row);
    },
    async listEnabledVersions(accountId) {
      const { rows } = await client.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM (
           SELECT DISTINCT ON (automation_id) ${VERSION_COLUMNS}
           FROM automation_versions
           WHERE account_id = $1
           ORDER BY automation_id, created_seq DESC
         ) latest
         WHERE enabled
         ORDER BY automation_id`,
        [accountId],
      );
      return rows.map(toVersion);
    },

    async lockConversation(accountId, contactId) {
      // Advisory, not a row lock: a conversation has no row of its own, and the
      // lock must already exist before the conversation's first run does.
      // JSON keeps the key unambiguous for ids containing any separator; a hash
      // collision only makes two conversations share a lock.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        JSON.stringify([accountId, contactId]),
      ]);
    },
    async getRun(runId) {
      const row = await one<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1`, [runId]);
      return row && toRun(row);
    },
    async findRunByComment(accountId, commentId) {
      const row = await one<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM runs WHERE account_id = $1 AND trigger_comment_id = $2`,
        [accountId, commentId],
      );
      return row && toRun(row);
    },
    async findActiveRun(accountId, contactId) {
      // Status list is written out (not a parameter) so the planner can match the partial unique index.
      const row = await one<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM runs
         WHERE account_id = $1 AND contact_id = $2 AND status IN ('running', 'awaiting_effect', 'waiting_reply')`,
        [accountId, contactId],
      );
      return row && toRun(row);
    },
    async findOldestQueuedRun(accountId, contactId) {
      const row = await one<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM runs
         WHERE account_id = $1 AND contact_id = $2 AND status = 'queued'
         ORDER BY created_at, id
         LIMIT 1`,
        [accountId, contactId],
      );
      return row && toRun(row);
    },
    async hasRunSince(automationId, contactId, since) {
      const row = await one<{ found: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM runs WHERE automation_id = $1 AND contact_id = $2 AND created_at >= $3
         ) AS found`,
        [automationId, contactId, since],
      );
      return row?.found === true;
    },
    async insertRun(run) {
      await writeRun(`INSERT INTO runs (${RUN_COLUMNS}) VALUES (${placeholders(17)})`, run);
    },
    async updateRun(run) {
      const { rowCount } = await writeRun(`UPDATE runs SET ${assignments(RUN_COLUMNS)} WHERE id = $1`, run);
      if (rowCount === 0) throw new Error(`run ${run.id} not found`);
    },
    async listDueTimers(now, limit) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM runs
         WHERE status = 'waiting_reply' AND wake_at <= $1
         ORDER BY wake_at, id
         LIMIT $2`,
        [now, limit],
      );
      return rows.map((r) => r.id);
    },

    async insertMessage(m) {
      const { rowCount } = await client.query(
        `INSERT INTO messages (${MESSAGE_COLUMNS}) VALUES (${placeholders(6)}) ON CONFLICT DO NOTHING`,
        [m.id, m.accountId, m.contactId, m.text, m.receivedAt, m.consumedByRunId],
      );
      return rowCount === 1;
    },
    async listUnconsumedMessages(accountId, contactId, since) {
      const { rows } = await client.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
         WHERE account_id = $1 AND contact_id = $2 AND consumed_by_run_id IS NULL AND received_at >= $3
         ORDER BY received_at, id`,
        [accountId, contactId, since],
      );
      return rows.map(toMessage);
    },
    async markMessageConsumed(messageId, runId) {
      await updateOne(`message ${messageId}`, 'UPDATE messages SET consumed_by_run_id = $2 WHERE id = $1', [
        messageId,
        runId,
      ]);
    },

    async insertEffect(e) {
      await client.query(
        `INSERT INTO effects (${EFFECT_COLUMNS}) VALUES (${placeholders(16)}) ON CONFLICT DO NOTHING`,
        effectParams(e),
      );
    },
    async getEffect(key) {
      const row = await one<EffectRow>(`SELECT ${EFFECT_COLUMNS} FROM effects WHERE key = $1`, [key]);
      return row && toEffect(row);
    },
    async updateEffect(e) {
      await updateOne(`effect ${e.key}`, `UPDATE effects SET ${assignments(EFFECT_COLUMNS)} WHERE key = $1`, effectParams(e));
    },
    async claimDueEffects(now, limit, leaseMs) {
      const returned = EFFECT_COLUMNS.split(', ')
        .map((c) => `e.${c}`)
        .join(', ');
      // SENT_FIRST kinds sort before the rest (false < true).
      const { rows } = await client.query<EffectRow & { was_in_flight: boolean }>(
        `WITH due AS (
           SELECT e.key, e.status
           FROM effects e
           WHERE ((e.status = 'pending' AND e.next_attempt_at <= $1)
               OR (e.status = 'sending' AND e.lease_until <= $1))
             AND NOT EXISTS (
               SELECT 1 FROM account_throttles t
               WHERE t.account_id = e.account_id AND t.kind = e.kind AND t.throttled_until > $1)
           ORDER BY e.kind <> ALL($4::text[]), e.next_attempt_at, e.key
           LIMIT $2
           FOR UPDATE OF e SKIP LOCKED
         ), claimed AS (
           UPDATE effects e
           SET status = 'sending', attempts = e.attempts + 1, lease_until = $1 + $3, updated_at = $1
           FROM due
           WHERE e.key = due.key
           RETURNING ${returned}, due.status = 'sending' AS was_in_flight
         )
         SELECT ${EFFECT_COLUMNS}, was_in_flight FROM claimed
         ORDER BY kind <> ALL($4::text[]), next_attempt_at, key`,
        [now, limit, leaseMs, SENT_FIRST],
      );
      return rows.map((r): ClaimedEffect => ({ effect: toEffect(r), wasInFlight: r.was_in_flight }));
    },

    async setAccountThrottle(accountId, kind, until) {
      await client.query(
        `INSERT INTO account_throttles (account_id, kind, throttled_until) VALUES ($1, $2, $3)
         ON CONFLICT (account_id, kind) DO UPDATE
         SET throttled_until = GREATEST(account_throttles.throttled_until, EXCLUDED.throttled_until)`,
        [accountId, kind, until],
      );
    },
    async getAccountThrottle(accountId, kind) {
      const row = await one<{ throttled_until: BigintText }>(
        'SELECT throttled_until FROM account_throttles WHERE account_id = $1 AND kind = $2',
        [accountId, kind],
      );
      return row && Number(row.throttled_until);
    },

    async upsertLead(accountId, contactId, field, value, at) {
      await client.query(
        `INSERT INTO leads (account_id, contact_id, field, value, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, contact_id, field) DO UPDATE
         SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [accountId, contactId, field, value, at],
      );
    },
    async getLeadFields(accountId, contactId) {
      const { rows } = await client.query<{ field: string; value: string }>(
        'SELECT field, value FROM leads WHERE account_id = $1 AND contact_id = $2',
        [accountId, contactId],
      );
      return Object.fromEntries(rows.map((r) => [r.field, r.value]));
    },
    async appendRunLog(runId, at, entry) {
      await client.query('INSERT INTO run_log (run_id, at, entry) VALUES ($1, $2, $3)', [runId, at, entry]);
    },
    async listRunLog(runId) {
      const { rows } = await client.query<RunLogRow>(
        'SELECT run_id, at, entry FROM run_log WHERE run_id = $1 ORDER BY seq',
        [runId],
      );
      return rows.map(toRunLogEntry);
    },
  };
}
