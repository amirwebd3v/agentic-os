-- Sync state (E3). `mail_pending` holds ids only: what to fetch next, never mail content.
CREATE TABLE mail_pending (
  account_id INTEGER NOT NULL REFERENCES mail_accounts (id) ON DELETE CASCADE,
  gmail_id   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, gmail_id)
);

ALTER TABLE mail_accounts ADD COLUMN list_after INTEGER;          -- set while listing: the `after:` epoch
ALTER TABLE mail_accounts ADD COLUMN next_history_id TEXT;        -- from getProfile before paging; becomes history_id after the last page
ALTER TABLE mail_accounts ADD COLUMN history_page_token TEXT;
ALTER TABLE mail_accounts ADD COLUMN estimate INTEGER;            -- resultSizeEstimate: for display only
ALTER TABLE mail_accounts ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_accounts ADD COLUMN last_error TEXT;             -- a fixed code
