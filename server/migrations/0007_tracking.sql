-- Application tracking: dated milestones per application, editable by the owner. See docs/week2/career-contract.md §5.
-- `note` is personal free text: it lives here only, never in events, audit, errors or logs.
CREATE TABLE application_milestones (
  id             INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  kind           TEXT NOT NULL CHECK (kind IN ('applied', 'feedback', 'interview', 'offer', 'rejected', 'withdrawn', 'note')),
  on_date        TEXT NOT NULL CHECK (date(on_date) IS on_date),   -- a real YYYY-MM-DD (`=` would pass NULL); may be in the future
  note           TEXT CHECK (note IS NULL OR length(note) <= 2000),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX application_milestones_app_date ON application_milestones (application_id, on_date);
