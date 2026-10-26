-- W1-12: bank questions asked in persona sessions. Drives the daily cap and tells `extract_persona` which ids a session covered.
CREATE TABLE persona_questions (
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  asked_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (session_id, question_id)
);
CREATE INDEX persona_questions_asked_at ON persona_questions (asked_at);
