import { expect, test } from 'vitest';
import { migrate } from '../src/db/migrate.ts';
import { makeTestDb } from './helpers.ts';

test('0005 expires chat-era approvals and fails their jobs, and touches nothing else', () => {
  const db = makeTestDb();
  db.pragma('user_version = 4'); // as a database from before the cleanup
  const approval = (type: string, status = 'pending') =>
    db.prepare(`INSERT INTO approvals (action_type, payload, proposed_by, status) VALUES (?, '{}', 'test', ?) RETURNING id`).pluck().get(type, status) as number;
  const job = (kind: string, status: string) =>
    db.prepare(`INSERT INTO jobs (kind, idempotency_key, payload, status) VALUES (?, ?, '{}', ?) RETURNING id`).pluck().get(kind, `${kind}:${status}`, status) as number;

  const cat = approval('propose_category');
  const persona = approval('persona_statement');
  const conflict = approval('vault_conflict');
  const decided = approval('propose_category', 'approved');
  const queued = job('categorize_session', 'queued');
  const running = job('extract_persona', 'running');
  const done = job('categorize_session', 'done');
  const other = job('career_intake', 'queued');

  migrate(db);

  const status = (table: string, id: number) => db.prepare(`SELECT status FROM ${table} WHERE id = ?`).pluck().get(id);
  expect([cat, persona, conflict, decided].map((id) => status('approvals', id))).toEqual(['expired', 'expired', 'pending', 'approved']);
  expect([queued, running, done, other].map((id) => status('jobs', id))).toEqual(['failed', 'failed', 'done', 'queued']);
  expect(db.prepare('SELECT error FROM jobs WHERE id = ?').pluck().get(queued)).toBe('feature removed');
});
