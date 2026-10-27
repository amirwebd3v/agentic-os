import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { editDistance } from '../src/approvals/edit-distance.ts';
import { expireStale } from '../src/approvals/expire.ts';
import { approvalRoutes, DAILY_CAP } from '../src/http/routes/approvals.ts';
import { sha256 } from '../src/vault/writer.ts';
import { buildTestApp } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Test app with the approvals plugin on its own temp vault. */
async function setupApprovals() {
  const vault = mkdtempSync(join(tmpdir(), 'aos-approvals-'));
  dirs.push(vault);
  const t = await buildTestApp({ loggedIn: true, plugins: [approvalRoutes({ vaultDir: vault })] });
  const { db } = t;
  const propose = (type: string, payload: object, original: string | null = null, createdAt?: string) =>
    (
      db
        .prepare(
          `INSERT INTO approvals (action_type, payload, proposed_by, original_text, created_at)
           VALUES (?, ?, 'test', ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) RETURNING id`,
        )
        .get(type, JSON.stringify(payload), original, createdAt ?? null) as { id: number }
    ).id;
  // A type with no approval handler: enough to exercise the queue itself (cap, batch, expiry, rejection).
  const item = (extra: object = {}) => propose('test_item', extra);
  const decide = (id: number, body: object) => t.app.inject(t.authed({ method: 'POST', url: `/api/approvals/${id}/decide`, payload: body }));
  const row = (id: number) => db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown>;
  const audits = () => (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map((r) => r.action);
  const list = async (qs = '') => (await t.app.inject(t.authed({ url: `/api/approvals?status=pending${qs}` }))).json();
  return { ...t, vault, propose, item, decide, row, audits, list };
}

test('normalized edit distance', () => {
  expect(editDistance('abc', 'abc')).toBe(0);
  expect(editDistance('abc', 'xyz')).toBe(1);
  expect(editDistance('kitten', 'sitting')).toBeCloseTo(3 / 7);
  expect(editDistance('', 'ab')).toBe(1);
});

test('approving a vault conflict overwrites only if the file is unchanged', async () => {
  const t = await setupApprovals();
  const file = join(t.vault, 'note.md');
  writeFileSync(file, 'mine');
  const id = t.propose('vault_conflict', { path: 'note.md', current_hash: sha256('mine'), content: 'theirs' });
  const listed = (await t.list()).items[0];
  expect(listed).toMatchObject({ id, current_text: 'mine', payload: { content: 'theirs' } });
  expect((await t.decide(id, { decision: 'approve', final_text: 'x' })).statusCode).toBe(400); // not editable

  writeFileSync(file, 'mine, edited again');
  expect((await t.decide(id, { decision: 'approve' })).statusCode).toBe(409);
  expect(readFileSync(file, 'utf8')).toBe('mine, edited again');
  expect(t.row(id).status).toBe('pending');
  expect(JSON.parse(t.row(id).payload as string).current_hash).toBe(sha256('mine, edited again')); // refreshed

  expect((await t.decide(id, { decision: 'approve' })).json()).toEqual({ id, status: 'approved' });
  expect(readFileSync(file, 'utf8')).toBe('theirs');
  expect(t.db.prepare(`SELECT content_hash, last_written_by FROM vault_notes WHERE path = 'note.md'`).get()).toEqual({
    content_hash: sha256('theirs'),
    last_written_by: 'app',
  });
  expect(t.audits()).toContain('approval.approve');
});

test('rejecting a vault conflict keeps the file and records it as the user’s', async () => {
  const t = await setupApprovals();
  writeFileSync(join(t.vault, 'note.md'), 'mine');
  t.db.prepare(`INSERT INTO vault_notes (path, content_hash, last_written_by) VALUES ('note.md', 'old', 'app')`).run();
  const id = t.propose('vault_conflict', { path: 'note.md', current_hash: sha256('mine'), content: 'theirs' });
  await t.decide(id, { decision: 'reject' });
  expect(readFileSync(join(t.vault, 'note.md'), 'utf8')).toBe('mine');
  expect(t.db.prepare(`SELECT content_hash, last_written_by FROM vault_notes WHERE path = 'note.md'`).get()).toEqual({
    content_hash: sha256('mine'),
    last_written_by: 'user',
  });
  expect(t.audits()).toContain('approval.reject');
});

test('a conflict path outside the vault is refused', async () => {
  const t = await setupApprovals();
  const id = t.propose('vault_conflict', { path: '../escape.md', current_hash: null, content: 'x' });
  expect((await t.decide(id, { decision: 'approve' })).statusCode).toBe(500);
  expect(t.row(id).status).toBe('pending');
});

test('a type nobody handles can be rejected but not approved', async () => {
  const t = await setupApprovals();
  const id = t.item();
  const refused = await t.decide(id, { decision: 'approve' });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error).toMatch(/reject it to clear it/);
  expect(t.row(id).status).toBe('pending');
  expect((await t.decide(id, { decision: 'reject' })).json()).toEqual({ id, status: 'rejected' });
  expect((await t.decide(id, { decision: 'reject', final_text: 'x' })).statusCode).toBe(409); // already decided
});

test('stale proposals expire, conflicts do not', async () => {
  const t = await setupApprovals();
  const a = t.propose('test_item', {}, null, '2026-11-01T00:00:00.000Z');
  const b = t.propose('vault_conflict', {}, null, '2026-11-01T00:00:00.000Z');
  const c = t.propose('test_item', {}, null, '2026-11-10T00:00:00.000Z');
  expect(expireStale(t.db, new Date('2026-11-20T00:00:00.000Z'))).toBe(1);
  expect([a, b, c].map((id) => t.row(id).status)).toEqual(['expired', 'pending', 'pending']);
  expect(t.audits()).toContain('approval.expire');
});

test(`shows at most ${DAILY_CAP} items a day, oldest first; batch reject works`, async () => {
  const t = await setupApprovals();
  const ids = Array.from({ length: 20 }, () => t.item());
  let page = await t.list();
  expect(page.items.map((i: { id: number }) => i.id)).toEqual(ids.slice(0, DAILY_CAP));
  expect(page).toMatchObject({ more: 5, total: 20 });

  const batch = await t.app.inject(t.authed({ method: 'POST', url: '/api/approvals/batch', payload: { ids: ids.slice(0, 10), decision: 'reject' } }));
  expect(batch.json().every((r: { ok: boolean }) => r.ok)).toBe(true);
  page = await t.list();
  expect(page.items).toHaveLength(DAILY_CAP - 10); // decisions count against today's budget
  expect(page).toMatchObject({ more: 5, total: 10 });
  expect((await t.list('&all=true')).items).toHaveLength(10);
});

test('batch reports per-item failures; inputs are validated', async () => {
  const t = await setupApprovals();
  const ok = t.item();
  const res = await t.app.inject(t.authed({ method: 'POST', url: '/api/approvals/batch', payload: { ids: [ok, 999], decision: 'reject' } }));
  expect(res.json()).toEqual([
    { id: ok, ok: true, status: 'rejected' },
    { id: 999, ok: false, error: 'not found' },
  ]);
  const bad = (payload: object) => t.app.inject(t.authed({ method: 'POST', url: '/api/approvals/batch', payload }));
  expect((await bad({ ids: [], decision: 'reject' })).statusCode).toBe(400);
  expect((await bad({ ids: [1, 1], decision: 'reject' })).statusCode).toBe(400);
  expect((await bad({ ids: [1], decision: 'maybe' })).statusCode).toBe(400);
  expect((await t.decide(ok, { decision: 'approve', final_text: 'x'.repeat(2001) })).statusCode).toBe(400);
  expect((await t.app.inject(t.authed({ url: '/api/approvals?status=approved' }))).statusCode).toBe(400);
});

test('approvals need a session', async () => {
  const t = await setupApprovals();
  const res = await t.app.inject({ url: '/api/approvals', headers: { host: '127.0.0.1:3000' } });
  expect(res.statusCode).toBe(401);
});

test('a malformed conflict payload can still be rejected; over-long originals can’t be edited', async () => {
  const t = await setupApprovals();
  const bad = t.propose('vault_conflict', { nope: true });
  expect((await t.decide(bad, { decision: 'reject' })).json()).toEqual({ id: bad, status: 'rejected' });
  const long = t.propose('test_item', {}, 'a'.repeat(5000));
  expect((await t.decide(long, { decision: 'approve', final_text: 'b' })).statusCode).toBe(400);
});
