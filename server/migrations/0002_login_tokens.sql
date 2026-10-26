-- One-time login links (W1-04). Only the sha256 is stored; rows are deleted on use.
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
