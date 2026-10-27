-- W2-00: the chat channel, session filing and persona interviews were removed. Close what they left open, so the
-- review queue shows nothing it can no longer apply and the runner doesn't retry jobs that have no handler.
UPDATE approvals
   SET status = 'expired', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status = 'pending' AND action_type IN ('propose_category', 'persona_statement');

UPDATE jobs
   SET status = 'failed', locked_at = NULL, error = 'feature removed'
 WHERE status IN ('queued', 'running') AND kind IN ('categorize_session', 'extract_persona');
