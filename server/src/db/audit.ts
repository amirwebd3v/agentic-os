import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';

export interface AuditEntry {
  actor: string;
  action: string;
  args: unknown;
  decision?: string;
  approver?: string;
}

interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  action: string;
  args_redacted: string;
  decision: string | null;
  approver: string | null;
  prev_hash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);
const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie/i;

// ponytail: key-name redaction only, add value scanning if secrets show up in free-text args
const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(v)]),
    );
  }
  return value;
};

/** JSON with object keys sorted at every level, so the hash does not depend on key order. */
const canonicalJSON = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

const hashRow = (r: Omit<AuditRow, 'id' | 'hash'>): string =>
  createHash('sha256')
    .update(
      r.prev_hash +
        canonicalJSON({
          ts: r.ts,
          actor: r.actor,
          action: r.action,
          args_redacted: r.args_redacted,
          decision: r.decision,
          approver: r.approver,
        }),
    )
    .digest('hex');

/** Appends a hash-chained entry: hash = sha256(prev_hash + canonicalJSON(entry)). */
export function audit(db: Database, entry: AuditEntry): void {
  db.transaction(() => {
    const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined;
    const row = {
      ts: new Date().toISOString(),
      actor: entry.actor,
      action: entry.action,
      args_redacted: canonicalJSON(redact(entry.args ?? null)),
      decision: entry.decision ?? null,
      approver: entry.approver ?? null,
      prev_hash: last?.hash ?? GENESIS,
    };
    db.prepare(
      `INSERT INTO audit_log (ts, actor, action, args_redacted, decision, approver, prev_hash, hash)
       VALUES (@ts, @actor, @action, @args_redacted, @decision, @approver, @prev_hash, @hash)`,
    ).run({ ...row, hash: hashRow(row) });
  }).immediate();
}

/** Walks the whole log; false if any row was altered, removed or reordered. */
export function verifyAuditChain(db: Database): boolean {
  let prev = GENESIS;
  for (const row of db.prepare('SELECT * FROM audit_log ORDER BY id').iterate() as IterableIterator<AuditRow>) {
    if (row.prev_hash !== prev || hashRow(row) !== row.hash) return false;
    prev = row.hash;
  }
  return true;
}
