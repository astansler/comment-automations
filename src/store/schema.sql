-- Timestamps are epoch milliseconds in bigint columns: the pure core works in millis.
-- Ids used as ORDER BY tie-breakers are COLLATE "C" so they sort bytewise, as in the memory store.
-- Each index names the query in pg.ts it serves.

CREATE TABLE inbound_events (
  event_id    text PRIMARY KEY,
  received_at bigint NOT NULL
);

CREATE TABLE automation_versions (
  id               text PRIMARY KEY,
  automation_id    text COLLATE "C" NOT NULL,
  account_id       text NOT NULL,
  enabled          boolean NOT NULL,
  cooldown_seconds integer NOT NULL CHECK (cooldown_seconds >= 0),
  definition       jsonb NOT NULL,
  -- Publication order; the latest version of an automation is the one with the highest created_seq.
  created_seq      bigserial NOT NULL
);
-- listEnabledVersions: latest version per automation of an account.
CREATE INDEX automation_versions_latest ON automation_versions (account_id, automation_id, created_seq DESC);

CREATE TABLE runs (
  id                 text COLLATE "C" PRIMARY KEY,
  automation_id      text NOT NULL,
  version_id         text NOT NULL,
  account_id         text NOT NULL,
  contact_id         text NOT NULL,
  trigger_comment_id text NOT NULL,
  status             text NOT NULL CHECK (status IN (
                       'queued', 'running', 'awaiting_effect', 'waiting_reply',
                       'completed', 'failed', 'expired', 'cancelled')),
  step_index         integer NOT NULL,
  attempt            integer NOT NULL,
  context            jsonb NOT NULL,
  window_open        boolean NOT NULL,
  pending_effect_key text,
  wake_at            bigint,
  outcome            text,
  created_at         bigint NOT NULL,
  started_at         bigint,
  updated_at         bigint NOT NULL,
  -- insertRun / updateRun invariant: a comment starts at most one run, because the
  -- platform gives a comment one private reply. Also serves findRunByComment.
  CONSTRAINT runs_trigger_unique UNIQUE (account_id, trigger_comment_id)
);
-- insertRun / updateRun invariant: one owner per conversation (ACTIVE_STATUSES); also serves findActiveRun.
CREATE UNIQUE INDEX runs_one_active_per_conversation ON runs (account_id, contact_id)
  WHERE status IN ('running', 'awaiting_effect', 'waiting_reply');
-- findOldestQueuedRun.
CREATE INDEX runs_queued ON runs (account_id, contact_id, created_at, id) WHERE status = 'queued';
-- hasRunSince.
CREATE INDEX runs_by_automation_contact ON runs (automation_id, contact_id, created_at);
-- listDueTimers.
CREATE INDEX runs_due_timers ON runs (wake_at, id) WHERE status = 'waiting_reply';

CREATE TABLE messages (
  id                 text COLLATE "C" PRIMARY KEY,
  account_id         text NOT NULL,
  contact_id         text NOT NULL,
  text               text NOT NULL,
  received_at        bigint NOT NULL,
  consumed_by_run_id text
);
-- listUnconsumedMessages.
CREATE INDEX messages_unconsumed ON messages (account_id, contact_id, received_at)
  WHERE consumed_by_run_id IS NULL;

CREATE TABLE effects (
  key             text COLLATE "C" PRIMARY KEY,
  run_id          text NOT NULL,
  account_id      text NOT NULL,
  contact_id      text NOT NULL,
  comment_id      text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('reply_to_comment', 'private_reply', 'direct_message')),
  policy          text NOT NULL CHECK (policy IN ('retry_safe', 'at_most_once', 'at_least_once')),
  text            text NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts        integer NOT NULL,
  next_attempt_at bigint NOT NULL,
  lease_until     bigint,
  provider_id     text,
  last_error      text,
  created_at      bigint NOT NULL,
  updated_at      bigint NOT NULL
);
-- claimDueEffects: pending rows that are due.
CREATE INDEX effects_pending_due ON effects (next_attempt_at) WHERE status = 'pending';
-- claimDueEffects: sending rows whose lease expired.
CREATE INDEX effects_sending_lease ON effects (lease_until) WHERE status = 'sending';

CREATE TABLE account_throttles (
  account_id      text PRIMARY KEY,
  throttled_until bigint NOT NULL
);

CREATE TABLE leads (
  account_id text NOT NULL,
  contact_id text NOT NULL,
  field      text NOT NULL,
  value      text NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (account_id, contact_id, field)
);

CREATE TABLE run_log (
  -- Append order; entries with the same `at` keep the order they were written in.
  seq    bigserial PRIMARY KEY,
  run_id text NOT NULL,
  at     bigint NOT NULL,
  entry  text NOT NULL
);
-- listRunLog.
CREATE INDEX run_log_by_run ON run_log (run_id, seq);
