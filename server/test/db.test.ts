import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/index.ts';
import type { Database } from '../src/db/index.ts';
import { migrate } from '../src/db/migrate.ts';
import { audit, verifyAuditChain } from '../src/db/audit.ts';
import { enqueue, claimNext, complete, fail, recoverStaleLocks, MAX_ATTEMPTS } from '../src/db/jobs.ts';
import { makeTestDb } from './helpers.ts';

// Highest NNNN_*.sql, so adding a migration needs no test edit.
const LATEST = Math.max(...readdirSync(new URL('../migrations/', import.meta.url)).map((n) => Number(n.slice(0, 4))));

let db: Database;
beforeEach(() => {
  db = makeTestDb();
});

describe('db', () => {
  test('fresh file db is WAL, migrated to the latest user_version, seeded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aos-db-'));
    try {
      const file = openDb(join(dir, 'nested', 'brain.db'));
      expect(file.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(file.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(file.pragma('user_version', { simple: true })).toBe(LATEST);
      expect(file.prepare("SELECT count(*) n FROM areas WHERE status = 'active'").get()).toEqual({ n: 10 });
      file.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('migrations are idempotent', () => {
    expect(() => migrate(db)).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST);
  });

  test('audit log is append-only and chained', () => {
    audit(db, { actor: 'test', action: 'a', args: {} });
    audit(db, { actor: 'test', action: 'b', args: { z: 1, a: [2] }, decision: 'approve', approver: 'user' });
    expect(verifyAuditChain(db)).toBe(true);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE audit_log SET actor = 'x'").run()).toThrow(/append-only/);
  });

  test('audit chain detects tampering', () => {
    audit(db, { actor: 'test', action: 'a', args: {} });
    audit(db, { actor: 'test', action: 'b', args: {} });
    db.exec('DROP TRIGGER audit_no_update');
    db.prepare("UPDATE audit_log SET action = 'evil' WHERE id = 1").run();
    expect(verifyAuditChain(db)).toBe(false);
  });

  test('audit redacts secret-looking keys', () => {
    audit(db, { actor: 'test', action: 'login', args: { user: 'me', nested: { apiKey: 'sk-1', password: 'p' } } });
    const row = db.prepare('SELECT args_redacted FROM audit_log').get() as { args_redacted: string };
    expect(JSON.parse(row.args_redacted)).toEqual({ nested: { apiKey: '[redacted]', password: '[redacted]' }, user: 'me' });
  });

  test('jobs dedupe by idempotency key', () => {
    enqueue(db, 'categorize_session', 'k1', {});
    enqueue(db, 'categorize_session', 'k1', {});
    expect(db.prepare('SELECT count(*) n FROM jobs').get()).toEqual({ n: 1 });
    expect(claimNext(db)?.idempotency_key).toBe('k1');
    expect(claimNext(db)).toBeUndefined();
  });

  test('complete, fail with backoff, give up after max attempts', () => {
    enqueue(db, 'k', 'a', { x: 1 });
    const job = claimNext(db)!;
    expect(job.payload).toEqual({ x: 1 });
    fail(db, job.id, 'boom');
    expect(claimNext(db)).toBeUndefined(); // backoff pushes run_after into the future
    const due = db.prepare("UPDATE jobs SET run_after = '2000-01-01T00:00:00.000Z' WHERE id = ?");
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      due.run(job.id);
      fail(db, claimNext(db)!.id, 'boom');
    }
    expect(db.prepare('SELECT status, attempts FROM jobs').get()).toEqual({ status: 'failed', attempts: MAX_ATTEMPTS });

    enqueue(db, 'k', 'b', {});
    complete(db, claimNext(db)!.id);
    expect(db.prepare("SELECT status FROM jobs WHERE idempotency_key = 'b'").get()).toEqual({ status: 'done' });
  });

  test('stale locks are recovered, fresh ones are not', () => {
    enqueue(db, 'k', 'stale', {});
    enqueue(db, 'k', 'fresh', {});
    const stale = claimNext(db)!;
    claimNext(db);
    db.prepare("UPDATE jobs SET locked_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(stale.id);
    expect(recoverStaleLocks(db)).toBe(1);
    expect(claimNext(db)?.idempotency_key).toBe('stale');

    db.prepare(`UPDATE jobs SET attempts = ${MAX_ATTEMPTS}, locked_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(stale.id);
    recoverStaleLocks(db);
    expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(stale.id)).toEqual({ status: 'failed' });
  });
});
