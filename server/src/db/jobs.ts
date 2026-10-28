import type { Database } from 'better-sqlite3';

export interface Job {
  id: number;
  kind: string;
  idempotency_key: string;
  payload: unknown;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  run_after: string;
  locked_at: string | null;
  progress: string | null;
  error: string | null;
  created_at: string;
}

export const MAX_ATTEMPTS = 5;
// career_* steps get one attempt: a retry repeats a model call and hides the failure behind backoff (career contract §4).
const MAX_ATTEMPTS_OF_KIND = `CASE WHEN kind LIKE 'career\\_%' ESCAPE '\\' THEN 1 ELSE ${MAX_ATTEMPTS} END`;
const STALE_LOCK_MINUTES = 10;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Queues a job unless one with the same idempotency key exists. Returns true if inserted. */
export function enqueue(db: Database, kind: string, idempotencyKey: string, payload: unknown): boolean {
  const info = db
    .prepare('INSERT INTO jobs (kind, idempotency_key, payload) VALUES (?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING')
    .run(kind, idempotencyKey, JSON.stringify(payload ?? null));
  return info.changes === 1;
}

/** Atomically locks the next due job and counts the attempt. */
export function claimNext(db: Database): Job | undefined {
  const row = db
    .prepare(
      `UPDATE jobs SET status = 'running', locked_at = ${NOW}, attempts = attempts + 1
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= ${NOW} ORDER BY run_after, id LIMIT 1)
       RETURNING *`,
    )
    .get() as (Omit<Job, 'payload'> & { payload: string }) | undefined;
  return row && { ...row, payload: JSON.parse(row.payload) as unknown };
}

// ponytail: no lock token, assumes one worker loop; add a claim token if workers run in parallel
export function complete(db: Database, id: number): void {
  db.prepare(`UPDATE jobs SET status = 'done', locked_at = NULL, error = NULL WHERE id = ? AND status = 'running'`).run(id);
}

/** Requeues with exponential backoff (30 s · 2^attempts) until the kind's attempts cap, then marks failed. True when it gave up. */
export function fail(db: Database, id: number, error: string): boolean {
  const row = db
    .prepare(
      `UPDATE jobs SET locked_at = NULL, error = @error,
         status = CASE WHEN attempts < ${MAX_ATTEMPTS_OF_KIND} THEN 'queued' ELSE 'failed' END,
         run_after = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || (30 << attempts) || ' seconds')
       WHERE id = @id AND status = 'running' RETURNING status`,
    )
    .get({ id, error }) as { status: Job['status'] } | undefined;
  return row?.status === 'failed';
}

/** Requeues jobs left running by a crash or laptop sleep. Run on boot. Returns how many. */
export function recoverStaleLocks(db: Database): number {
  return db
    .prepare(
      `UPDATE jobs SET locked_at = NULL, status = CASE WHEN attempts < ${MAX_ATTEMPTS_OF_KIND} THEN 'queued' ELSE 'failed' END
       WHERE status = 'running' AND locked_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${STALE_LOCK_MINUTES} minutes')`,
    )
    .run().changes;
}
