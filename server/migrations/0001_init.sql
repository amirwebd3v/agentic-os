-- Week 1 subset of plan-review §4d. Timestamps are ISO-8601 UTC text (lexically sortable).

CREATE TABLE areas (
  id          INTEGER PRIMARY KEY,
  parent_id   INTEGER REFERENCES areas(id),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  mode        TEXT NOT NULL DEFAULT 'do' CHECK (mode IN ('do', 'explain', 'tutor')),
  status      TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'merged', 'archived')),
  created_by  TEXT NOT NULL CHECK (created_by IN ('user', 'model')),
  merged_into INTEGER REFERENCES areas(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Top-level areas from W1-08's CLAUDE.md template; W1-08's area sync owns them after boot.
INSERT INTO areas (slug, name, mode, status, created_by) VALUES
  ('software-development', 'Software development', 'do', 'active', 'user'),
  ('studies', 'Studies', 'tutor', 'active', 'user'),
  ('career', 'Career', 'do', 'active', 'user'),
  ('admin-finance', 'Admin & finance', 'do', 'active', 'user'),
  ('health', 'Health', 'do', 'active', 'user'),
  ('home-household', 'Home & household', 'do', 'active', 'user'),
  ('relationships-social', 'Relationships & social', 'do', 'active', 'user'),
  ('learning-reading', 'Learning & reading', 'do', 'active', 'user'),
  ('projects-side', 'Side projects', 'do', 'active', 'user'),
  ('personal-reflection', 'Personal reflection', 'do', 'active', 'user');

CREATE TABLE sessions (
  id                          INTEGER PRIMARY KEY,
  title                       TEXT,
  mode                        TEXT NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat', 'persona')),
  area_id                     INTEGER REFERENCES areas(id),
  tags                        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  area_confidence             REAL,
  filing_status               TEXT CHECK (filing_status IN ('auto', 'flagged', 'inbox', 'user')),
  last_categorized_message_id INTEGER,
  started_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at                    TEXT,
  summary_path                TEXT
);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content    TEXT NOT NULL,
  model      TEXT,
  status     TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('streaming', 'done', 'aborted', 'error')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX messages_session_created ON messages (session_id, created_at);

CREATE TABLE vault_notes (
  path            TEXT PRIMARY KEY,
  content_hash    TEXT NOT NULL,
  last_written_by TEXT NOT NULL CHECK (last_written_by IN ('app', 'user')),
  indexed_at      TEXT
);

CREATE TABLE decisions (
  id                INTEGER PRIMARY KEY,
  subject_type      TEXT NOT NULL,
  subject_id        TEXT NOT NULL,
  question          TEXT NOT NULL,
  answer            TEXT,
  confidence        REAL,
  backend           TEXT,
  model             TEXT,
  escalated         INTEGER NOT NULL DEFAULT 0 CHECK (escalated IN (0, 1)),
  final_answer      TEXT,
  corrected_by_user INTEGER NOT NULL DEFAULT 0 CHECK (corrected_by_user IN (0, 1)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX decisions_question_corrected ON decisions (question, corrected_by_user);

CREATE TABLE jobs (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload         TEXT NOT NULL CHECK (json_valid(payload)),
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  run_after       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  locked_at       TEXT,
  progress        TEXT CHECK (progress IS NULL OR json_valid(progress)),
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX jobs_status_run_after ON jobs (status, run_after);

CREATE TABLE approvals (
  id            INTEGER PRIMARY KEY,
  action_type   TEXT NOT NULL,
  payload       TEXT NOT NULL CHECK (json_valid(payload)),
  proposed_by   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at    TEXT,
  original_text TEXT,
  final_text    TEXT,
  edit_distance REAL
);
CREATE INDEX approvals_status ON approvals (status);

CREATE TABLE llm_calls (
  id                INTEGER PRIMARY KEY,
  ts                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  pipeline          TEXT NOT NULL,
  model             TEXT NOT NULL,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cache_read_tokens INTEGER,
  latency_ms        INTEGER,
  error             TEXT,
  job_id            INTEGER REFERENCES jobs(id)
);
CREATE INDEX llm_calls_ts ON llm_calls (ts);
CREATE INDEX llm_calls_pipeline_ts ON llm_calls (pipeline, ts);

CREATE TABLE auth_sessions (
  id         INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY,
  ts            TEXT NOT NULL,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  args_redacted TEXT NOT NULL CHECK (json_valid(args_redacted)),
  decision      TEXT,
  approver      TEXT,
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL UNIQUE
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
