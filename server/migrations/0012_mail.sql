-- Email slice (S2). Spec: docs/week3/email-spec.md. Gmail is read-only; nothing here is written back.
CREATE TABLE mail_accounts (
  id                  INTEGER PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'reconnect', 'disconnected')),
  history_id          TEXT,
  backfill_page_token TEXT,
  backfill_done       INTEGER NOT NULL DEFAULT 0 CHECK (backfill_done IN (0, 1)),
  last_synced_at      TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- `system` marks the two categories the gate depends on: they can be renamed but never removed.
CREATE TABLE mail_categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  system     TEXT UNIQUE CHECK (system IN ('personal', 'noise')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO mail_categories (name, system) VALUES
  ('Blog ideas', NULL), ('Social ideas', NULL), ('Career', NULL), ('Software development', NULL),
  ('Personal', 'personal'), ('Noise', 'noise');

-- A NULL category with state 'needs_sorting' is the Needs sorting list. The CHECKs are the last line of defence for
-- the spec's storage table: Personal keeps ids and category only, and is never eligible for Claude.
CREATE TABLE mail_messages (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES mail_accounts (id) ON DELETE CASCADE,
  gmail_id       TEXT NOT NULL,
  rfc_message_id TEXT,
  internal_date  TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('needs_sorting', 'filed', 'failed')),
  category_id    INTEGER REFERENCES mail_categories (id) ON DELETE SET NULL,
  suggestion_id  INTEGER REFERENCES mail_categories (id) ON DELETE SET NULL,
  source         TEXT CHECK (source IN ('rule', 'secrets', 'laya', 'claude', 'owner')),
  is_personal    INTEGER NOT NULL DEFAULT 0 CHECK (is_personal IN (0, 1)),
  eligible       INTEGER NOT NULL DEFAULT 0 CHECK (eligible IN (0, 1)),
  bulk           INTEGER NOT NULL DEFAULT 0 CHECK (bulk IN (0, 1)),
  sender         TEXT,
  subject        TEXT,
  excerpt        TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (account_id, gmail_id),
  CHECK (is_personal = 0 OR (sender IS NULL AND subject IS NULL AND excerpt IS NULL AND eligible = 0)),
  CHECK (state = 'filed' OR (excerpt IS NULL AND eligible = 0))
);
-- is_personal must agree with the category, or the CHECKs above guard nothing.
CREATE TRIGGER mail_messages_personal_insert BEFORE INSERT ON mail_messages
WHEN (NEW.category_id IS NOT NULL AND NEW.category_id = (SELECT id FROM mail_categories WHERE system = 'personal')) <> (NEW.is_personal = 1)
BEGIN SELECT RAISE(ABORT, 'is_personal disagrees with category'); END;
CREATE TRIGGER mail_messages_personal_update BEFORE UPDATE ON mail_messages
WHEN (NEW.category_id IS NOT NULL AND NEW.category_id = (SELECT id FROM mail_categories WHERE system = 'personal')) <> (NEW.is_personal = 1)
BEGIN SELECT RAISE(ABORT, 'is_personal disagrees with category'); END;

CREATE TRIGGER mail_categories_keep_system BEFORE DELETE ON mail_categories WHEN OLD.system IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'system category'); END;
-- A removed category's mail moves to Needs sorting, which holds no excerpt and is never eligible.
CREATE TRIGGER mail_categories_unfile BEFORE DELETE ON mail_categories WHEN OLD.system IS NULL
BEGIN UPDATE mail_messages SET state = 'needs_sorting', excerpt = NULL, eligible = 0, source = NULL WHERE category_id = OLD.id; END;

CREATE INDEX mail_messages_category ON mail_messages (category_id, internal_date);
CREATE INDEX mail_messages_rfc ON mail_messages (rfc_message_id);

-- "Always this sender". A rule also counts as the owner's approval of that sender (D7).
CREATE TABLE mail_sender_rules (
  sender      TEXT PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES mail_categories (id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE mail_analyses (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES mail_categories (id) ON DELETE CASCADE,
  day         TEXT NOT NULL,
  text        TEXT,
  cites       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cites)),
  status      TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  cost_usd    REAL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (category_id, day)
);
