import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
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

  test('career: events are append-only, status and dates are checked', () => {
    const { lastInsertRowid: id } = db.prepare("INSERT INTO applications (master_hash) VALUES ('h')").run();
    expect(db.prepare('SELECT status FROM applications WHERE id = ?').get(id)).toEqual({ status: 'processing' });
    db.prepare("INSERT INTO application_events (application_id, kind) VALUES (?, 'created')").run(id);
    expect(() => db.prepare("UPDATE application_events SET kind = 'step'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM application_events').run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE applications SET status = 'done' WHERE id = ?").run(id)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE applications SET follow_up_on = 'soon' WHERE id = ?").run(id)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'step', 'x')").run(id)).toThrow(/CHECK/);
  });

  test('0009 and 0010 rebuild applications and application_texts: rows, indexes, foreign keys and triggers survive', () => {
    // A database at 0008 with data in every table that points at applications.
    const old = new BetterSqlite3(':memory:');
    old.pragma('foreign_keys = ON');
    const dir = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(dir).filter((n) => Number(n.slice(0, 4)) <= 8).sort()) old.exec(readFileSync(new URL(name, dir), 'utf8'));
    old.pragma('user_version = 8');
    old.exec(`
      INSERT INTO applications (id, company, role_title, language, status, step, fail_code, follow_up_on, master_hash, archived_at, deleted_at)
        VALUES (7, 'C', 'R', 'en', 'final', 'render', 'render_failed', '2026-11-01', 'h', '2026-10-01T00:00:00.000Z', NULL);
      INSERT INTO applications (id, master_hash) VALUES (8, 'h2');
      INSERT INTO application_texts (application_id, kind, version, body) VALUES (7, 'draft', 1, '{}'), (7, 'draft', 2, '{"v":2}'), (8, 'posting', 1, 'p');
      INSERT INTO application_events (application_id, kind) VALUES (7, 'created'), (8, 'created');
      INSERT INTO application_milestones (application_id, kind, on_date) VALUES (7, 'applied', '2026-10-02');
      INSERT INTO application_files (application_id, kind, relpath, sha256, bytes) VALUES (7, 'cv_docx', '7/cv.docx', 'x', 1);
    `);
    const dump = (tables: string[]) => tables.map((t) => old.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
    const tables = ['applications', 'application_texts', 'application_events', 'application_milestones', 'application_files'];
    const before = dump(tables);

    migrate(old);
    expect(old.pragma('user_version', { simple: true })).toBe(LATEST);
    expect(old.pragma('foreign_keys', { simple: true })).toBe(1); // back on after the rebuild
    expect(dump(tables)).toEqual(before);
    expect(old.pragma('foreign_key_check')).toEqual([]);
    for (const t of ['application_texts', 'application_events', 'application_milestones', 'application_files'])
      expect((old.pragma(`foreign_key_list(${t})`) as { table: string }[]).map((f) => f.table)).toEqual(['applications']);
    expect(old.prepare("SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%' AND tbl_name LIKE 'application%' ORDER BY name").pluck().all()).toEqual([
      'application_events_no_delete', 'application_events_no_update', 'application_milestones_app_date', 'applications_status_updated',
    ]);
    expect(old.prepare("SELECT count(*) FROM sqlite_master WHERE name LIKE '%_v2'").pluck().get()).toBe(0);

    // Foreign keys enforce again, the append-only triggers still fire, the new values are allowed and old CHECKs hold.
    expect(() => old.prepare("INSERT INTO application_events (application_id, kind) VALUES (99, 'created')").run()).toThrow(/FOREIGN KEY/);
    expect(() => old.prepare('DELETE FROM application_events').run()).toThrow(/append-only/);
    expect(() => old.prepare('DELETE FROM applications WHERE id = 8').run()).toThrow(/FOREIGN KEY/);
    old.prepare("UPDATE applications SET status = 'needs_answers', step = 'questions' WHERE id = 8").run();
    for (const kind of ['gaps', 'ats', 'company', 'vacancy', 'questions', 'answers', 'context']) old.prepare("INSERT INTO application_texts (application_id, kind, body) VALUES (8, ?, '{}')").run(kind);
    for (const step of ['gaps', 'ats', 'company', 'vacancy', 'letter', 'letter_verify']) old.prepare('UPDATE applications SET step = ? WHERE id = 8').run(step);
    expect(() => old.prepare("UPDATE applications SET status = 'done' WHERE id = 8").run()).toThrow(/CHECK/);
    expect(() => old.prepare("INSERT INTO application_texts (application_id, kind, body) VALUES (8, 'letter', '{}')").run()).toThrow(/CHECK/);
    old.close();
  });
});
