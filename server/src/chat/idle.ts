import type { Database } from '../db/index.ts';
import { enqueue } from '../db/jobs.ts';

const TICK_MS = 60_000;

/** Queues `categorize_session` up to message `lastMsgId`. Idempotent per (session, last message). */
export const enqueueCategorize = (db: Database, sessionId: number, lastMsgId: number): boolean =>
  enqueue(db, 'categorize_session', `categorize:${sessionId}:${lastMsgId}`, { sessionId, upToMessageId: lastMsgId });

/** The newest finished message id of a session, or null. */
export const lastMessageId = (db: Database, sessionId: number): number | null =>
  (db.prepare(`SELECT MAX(id) id FROM messages WHERE session_id = ? AND status != 'streaming'`).get(sessionId) as { id: number | null }).id;

/** Queues every session idle for `idleMinutes` with messages newer than its last categorization. Returns how many were new. */
export function enqueueIdle(db: Database, idleMinutes: number): number {
  const due = db
    .prepare(
      `SELECT s.id, MAX(m.id) last FROM sessions s JOIN messages m ON m.session_id = s.id AND m.status != 'streaming'
       GROUP BY s.id
       HAVING MAX(m.created_at) <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
          AND (s.last_categorized_message_id IS NULL OR s.last_categorized_message_id < MAX(m.id))`,
    )
    .all(`-${idleMinutes} minutes`) as { id: number; last: number }[];
  return due.filter((s) => enqueueCategorize(db, s.id, s.last)).length;
}

/** Runs `enqueueIdle` every minute; returns the stop function. */
export function startIdleTimer(db: Database, idleMinutes: number, onError: (err: unknown) => void): () => void {
  const timer = setInterval(() => {
    try {
      enqueueIdle(db, idleMinutes);
    } catch (err) {
      onError(err);
    }
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
