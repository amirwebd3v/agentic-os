-- Career slice (Week 2): applications and their texts, files and append-only events. See docs/week2/career-contract.md §5.
CREATE TABLE applications (
  id           INTEGER PRIMARY KEY,
  company      TEXT,
  role_title   TEXT,
  language     TEXT CHECK (language IN ('en', 'de')),
  status       TEXT NOT NULL DEFAULT 'processing'
               CHECK (status IN ('processing', 'draft_ready', 'flagged', 'failed', 'final', 'applied', 'withdrawn')),
  step         TEXT CHECK (step IN ('intake', 'match', 'draft', 'verify', 'render')),
  fail_code    TEXT,
  follow_up_on TEXT CHECK (follow_up_on IS NULL OR date(follow_up_on) IS NOT NULL),   -- YYYY-MM-DD
  master_hash  TEXT NOT NULL,   -- sha256 of master.md when the run started
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX applications_status_updated ON applications (status, updated_at);

CREATE TABLE application_texts (
  application_id INTEGER NOT NULL REFERENCES applications(id),
  kind           TEXT NOT NULL CHECK (kind IN ('posting', 'requirements', 'selection', 'draft', 'verify_report')),
  version        INTEGER NOT NULL DEFAULT 1,
  body           TEXT NOT NULL,   -- raw text for 'posting', JSON for the rest
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (application_id, kind, version)
);

CREATE TABLE application_files (
  id             INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  kind           TEXT NOT NULL CHECK (kind IN ('cv_docx', 'cv_pdf', 'letter_docx', 'letter_pdf')),
  relpath        TEXT NOT NULL,   -- relative to dataDir/career/out
  sha256         TEXT NOT NULL,
  bytes          INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (application_id, kind)
);

CREATE TABLE application_events (
  id             INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  ts             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind           TEXT NOT NULL CHECK (kind IN ('created', 'step', 'failed', 'retry', 'edited', 'final', 'rendered', 'status')),
  detail         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail))   -- ids, counts, codes only
);
CREATE TRIGGER application_events_no_update BEFORE UPDATE ON application_events BEGIN SELECT RAISE(ABORT, 'application_events is append-only'); END;
CREATE TRIGGER application_events_no_delete BEFORE DELETE ON application_events BEGIN SELECT RAISE(ABORT, 'application_events is append-only'); END;
