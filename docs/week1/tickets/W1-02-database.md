---
id: W1-02
title: "SQLite foundation"
epic: AOS-W1
issue: https://github.com/amirwebd3v/agentic-os/issues/2
points: 3
wave: 2
risk: Low
depends_on:
  - "[[W1-01-scaffold]]"
skills:
  - sql-pro
---

# W1-02 — SQLite foundation: migrations, Week 1 tables, append-only audit log

**Points:** 3 · **Risk:** Low · **Depends on:** W1-01 · **Skill/agent:** `sql-pro`
Overview: [plan-review.md §4d](../../plan-review.md) · Plan: [implementation-plan.md](../implementation-plan.md)

## Summary
`better-sqlite3` with WAL, a plain-SQL migration runner (`PRAGMA user_version`), the Week 1 subset of the §4d schema, and a tamper-evident audit log. Out of scope: `items`, `files`, `mail_*`, chunks and vectors (Month 1).

## Implementation steps
1. **`server/src/db/index.ts`:** open `${dataDir}/brain.db` and set `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`. Export a singleton `db`.
2. **`server/src/db/migrate.ts`:** read `server/migrations/NNNN_*.sql` in order and apply each file whose number is greater than `user_version`, each inside one transaction. About 20 lines, no library.
3. **`server/migrations/0001_init.sql`:** the tables below (column details as in §4d).
   - `areas` (seeded with the top-level areas from W1-08's `CLAUDE.md`, `status='active'`, `created_by='user'`)
   - `sessions` (+ `mode CHECK IN('chat','persona')`, `last_categorized_message_id`)
   - `messages` (+ `status CHECK IN('streaming','done','aborted','error')`)
   - `approvals`, `llm_calls`, `decisions`, `vault_notes`, `jobs`
   - `auth_sessions(id PK, token_hash UNIQUE, created_at, expires_at)`
   - `audit_log(id INTEGER PK, ts, actor, action, args_redacted JSON, decision, approver, prev_hash, hash)`
   ```sql
   CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
   CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
   ```
4. **`server/src/db/audit.ts`:** `audit(entry)` computes `hash = sha256(prev_hash + canonicalJSON(entry))` and inserts. `verifyAuditChain()` walks the whole table.
5. **`server/src/db/jobs.ts`:** `enqueue(kind, key, payload)` uses `INSERT … ON CONFLICT(idempotency_key) DO NOTHING`. `claimNext()` sets `locked_at`. `complete` and `fail` update the row, retrying failures with backoff up to `attempts < 5`. On boot, jobs whose `locked_at` is older than 10 minutes are unlocked, so work resumes after the laptop sleeps.
6. **Backup helper (stub for Month 1):** `db.backup(path)` wrapper, unused for now.

## Files
| File | Action |
|---|---|
| `server/src/db/{index,migrate,audit,jobs}.ts` | Create |
| `server/migrations/0001_init.sql` | Create |
| `server/test/db.test.ts` | Create |

## Tests — `server/test/db.test.ts`
```ts
import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrate';
import { audit, verifyAuditChain } from '../src/db/audit';
import { enqueue, claimNext } from '../src/db/jobs';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); migrate(db); });

describe('db', () => {
  test('migrations are idempotent', () => { expect(() => migrate(db)).not.toThrow(); });
  test('audit log is append-only and chained', () => {
    audit(db, { actor: 'test', action: 'a', args: {} });
    audit(db, { actor: 'test', action: 'b', args: {} });
    expect(verifyAuditChain(db)).toBe(true);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
  });
  test('jobs dedupe by idempotency key', () => {
    enqueue(db, 'categorize_session', 'k1', {});
    enqueue(db, 'categorize_session', 'k1', {});
    expect(db.prepare('SELECT count(*) n FROM jobs').get()).toEqual({ n: 1 });
    expect(claimNext(db)?.idempotency_key).toBe('k1');
    expect(claimNext(db)).toBeUndefined();
  });
});
```

## Acceptance criteria
- [ ] A fresh `brain.db` is created on first boot with `user_version = 1`.
- [ ] Audit log UPDATE and DELETE both fail. The chain verifies.
- [ ] Job enqueue is idempotent, and stale locks are recovered on boot.
