-- Application admin: archive (hidden by the UI, still listed) and delete (texts, milestones and files gone, names
-- cleared; the row and its append-only events stay). See docs/week2/career-contract.md §5.
ALTER TABLE applications ADD COLUMN archived_at TEXT;
ALTER TABLE applications ADD COLUMN deleted_at TEXT;
