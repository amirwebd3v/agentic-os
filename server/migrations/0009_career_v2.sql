-- Career v2 (docs/week2/career-v2.md §5): status `needs_answers`; steps gaps, ats, company, vacancy, questions,
-- letter; text kinds gaps, ats, company, vacancy, answers. SQLite can't alter a CHECK, so both tables are rebuilt,
-- every row kept. migrate() runs this with foreign_keys off and checks them before commit; application_files,
-- application_events and application_milestones reference `applications` by name, so they point at the new table.
CREATE TABLE applications_v2 (
  id           INTEGER PRIMARY KEY,
  company      TEXT,
  role_title   TEXT,
  language     TEXT CHECK (language IN ('en', 'de')),
  status       TEXT NOT NULL DEFAULT 'processing'
               CHECK (status IN ('processing', 'needs_answers', 'draft_ready', 'flagged', 'failed', 'final', 'applied', 'withdrawn')),
  step         TEXT CHECK (step IN ('intake', 'match', 'gaps', 'draft', 'verify', 'ats', 'company', 'vacancy', 'questions', 'letter', 'render')),
  fail_code    TEXT,
  follow_up_on TEXT CHECK (follow_up_on IS NULL OR date(follow_up_on) IS NOT NULL),   -- YYYY-MM-DD
  master_hash  TEXT NOT NULL,   -- sha256 of master.md when the run started
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at  TEXT,
  deleted_at   TEXT
);
INSERT INTO applications_v2 (id, company, role_title, language, status, step, fail_code, follow_up_on, master_hash, created_at, updated_at, archived_at, deleted_at)
  SELECT id, company, role_title, language, status, step, fail_code, follow_up_on, master_hash, created_at, updated_at, archived_at, deleted_at FROM applications;
DROP TABLE applications;
ALTER TABLE applications_v2 RENAME TO applications;
CREATE INDEX applications_status_updated ON applications (status, updated_at);

CREATE TABLE application_texts_v2 (
  application_id INTEGER NOT NULL REFERENCES applications(id),
  kind           TEXT NOT NULL CHECK (kind IN ('posting', 'requirements', 'selection', 'gaps', 'draft', 'verify_report', 'ats', 'company', 'vacancy', 'answers')),
  version        INTEGER NOT NULL DEFAULT 1,
  body           TEXT NOT NULL,   -- raw text for 'posting', JSON for the rest
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (application_id, kind, version)
);
INSERT INTO application_texts_v2 (application_id, kind, version, body, created_at)
  SELECT application_id, kind, version, body, created_at FROM application_texts;
DROP TABLE application_texts;
ALTER TABLE application_texts_v2 RENAME TO application_texts;
