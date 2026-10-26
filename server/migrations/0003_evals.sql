-- Eval fixtures and their runs (W1-10 `pnpm eval:categorize`; the Month 1 golden set reuses them).
CREATE TABLE eval_cases (
  id       INTEGER PRIMARY KEY,
  suite    TEXT NOT NULL,
  name     TEXT NOT NULL,
  input    TEXT NOT NULL CHECK (json_valid(input)),
  expected TEXT NOT NULL,
  UNIQUE (suite, name)
);

CREATE TABLE eval_runs (
  id        INTEGER PRIMARY KEY,
  suite     TEXT NOT NULL,
  ran_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  model     TEXT NOT NULL,
  total     INTEGER NOT NULL,
  correct   INTEGER NOT NULL,
  escalated INTEGER NOT NULL,
  -- [{ case, expected, predicted, decider, confidence, escalated, correct }]
  results   TEXT NOT NULL CHECK (json_valid(results))
);
