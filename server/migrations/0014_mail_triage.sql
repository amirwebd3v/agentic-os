-- Triage (E4). `thresholds` is set by the owner's calibration run (E8); until then nothing auto-files on Laya alone.
ALTER TABLE mail_accounts ADD COLUMN triage_error TEXT; -- a fixed code
CREATE TABLE mail_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);
