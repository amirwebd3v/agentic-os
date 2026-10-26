import type { Database } from 'better-sqlite3';
import { audit } from '../db/audit.ts';

const MAX_AGE_DAYS = 14;

/** Marks pending proposals older than 14 days `expired`. Vault conflicts never expire: they hold an unsaved write. */
export function expireStale(db: Database, now = new Date()): number {
  const cutoff = new Date(now.getTime() - MAX_AGE_DAYS * 86_400_000).toISOString();
  return db.transaction(() => {
    const rows = db
      .prepare(
        `UPDATE approvals SET status = 'expired', decided_at = ?
         WHERE status = 'pending' AND action_type != 'vault_conflict' AND created_at < ? RETURNING id, action_type`,
      )
      .all(now.toISOString(), cutoff) as { id: number; action_type: string }[];
    for (const r of rows) audit(db, { actor: 'app', action: 'approval.expire', args: r, decision: 'expired' });
    return rows.length;
  })();
}
