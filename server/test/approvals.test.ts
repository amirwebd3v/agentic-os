import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { editDistance } from '../src/approvals/edit-distance.ts';
import { expireStale } from '../src/approvals/expire.ts';
import { verifyAuditChain } from '../src/db/audit.ts';
import { approvalRoutes, DAILY_CAP } from '../src/http/routes/approvals.ts';
import { parseAreas } from '../src/vault/areas.ts';
import { sha256 } from '../src/vault/writer.ts';
import { buildTestApp } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Test app with the approvals plugin on its own temp vault (seeded with the real CLAUDE.md template). */
async function setupApprovals() {
  const vault = mkdtempSync(join(tmpdir(), 'aos-approvals-'));
  dirs.push(vault);
  copyFileSync(new URL('../templates/CLAUDE.md', import.meta.url), join(vault, 'CLAUDE.md'));
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
  const category = (slug: string, extra: Record<string, unknown> = {}) => {
    const payload = { slug, name: 'Job search', description: 'Applying for jobs', reason: 'r', parent_slug: null, session_ids: [], ...extra };
    return propose('propose_category', payload, payload.description); // contract: original_text = description
  };
  const decide = (id: number, body: object) => t.app.inject(t.authed({ method: 'POST', url: `/api/approvals/${id}/decide`, payload: body }));
  const row = (id: number) => db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown>;
  const area = (slug: string) => db.prepare('SELECT * FROM areas WHERE slug = ?').get(slug) as Record<string, unknown> | undefined;
  const audits = () => (db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map((r) => r.action);
  const list = async (qs = '') => (await t.app.inject(t.authed({ url: `/api/approvals?status=pending${qs}` }))).json();
  return { ...t, vault, propose, category, decide, row, area, audits, list };
}

test('normalized edit distance', () => {
  expect(editDistance('abc', 'abc')).toBe(0);
  expect(editDistance('abc', 'xyz')).toBe(1);
  expect(editDistance('kitten', 'sitting')).toBeCloseTo(3 / 7);
  expect(editDistance('', 'ab')).toBe(1);
});

test('approving a top-level category activates it, appends it to CLAUDE.md and re-files inbox sessions', async () => {
  const t = await setupApprovals();
  const s1 = (t.db.prepare(`INSERT INTO sessions (filing_status) VALUES ('inbox') RETURNING id`).get() as { id: number }).id;
  const s2 = (t.db.prepare(`INSERT INTO sessions (filing_status) VALUES ('auto') RETURNING id`).get() as { id: number }).id;
  const s3 = (t.db.prepare(`INSERT INTO sessions (filing_status) VALUES ('inbox') RETURNING id`).get() as { id: number }).id; // no messages
  for (const s of [s1, s2]) t.db.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'user', 'hi')`).run(s);
  const last = (t.db.prepare('SELECT MAX(id) id FROM messages WHERE session_id = ?').get(s1) as { id: number }).id;
  const id = t.category('job-search', { session_ids: [s1, s2, s3] });

  const res = await t.decide(id, { decision: 'approve' });
  expect(res.json()).toEqual({ id, status: 'approved' });
  expect(t.area('job-search')).toMatchObject({ status: 'active', created_by: 'user', parent_id: null, description: 'Applying for jobs' });
  const md = readFileSync(join(t.vault, 'CLAUDE.md'), 'utf8');
  expect(parseAreas(md).at(-1)).toEqual({ slug: 'job-search', name: 'Job search', mode: 'do', description: 'Applying for jobs' });
  expect(t.db.prepare(`SELECT content_hash, last_written_by FROM vault_notes WHERE path = 'CLAUDE.md'`).get()).toEqual({
    content_hash: sha256(md),
    last_written_by: 'user',
  });
  const jobs = t.db.prepare('SELECT kind, idempotency_key, payload FROM jobs').all();
  expect(jobs).toEqual([
    { kind: 'categorize_session', idempotency_key: `recategorize:${s1}:${id}`, payload: JSON.stringify({ sessionId: s1, upToMessageId: last }) },
  ]);
  expect(t.row(id)).toMatchObject({ status: 'approved', final_text: 'Applying for jobs', edit_distance: 0 });
  expect(t.audits()).toContain('approval.approve');
  expect(verifyAuditChain(t.db)).toBe(true);
  expect((await t.decide(id, { decision: 'approve' })).statusCode).toBe(409);
});

test('editing before approving stores the edit distance and the edited description', async () => {
  const t = await setupApprovals();
  const id = t.category('job-search');
  await t.decide(id, { decision: 'approve', final_text: 'Applying for jobs abroad' });
  expect(t.row(id)).toMatchObject({ final_text: 'Applying for jobs abroad', edit_distance: editDistance('Applying for jobs', 'Applying for jobs abroad') });
  expect(t.area('job-search')?.description).toBe('Applying for jobs abroad');
  expect(readFileSync(join(t.vault, 'CLAUDE.md'), 'utf8')).toContain('- `job-search` | Job search | do | Applying for jobs abroad');
});

test('a subarea goes under its parent and leaves CLAUDE.md alone', async () => {
  const t = await setupApprovals();
  const before = readFileSync(join(t.vault, 'CLAUDE.md'), 'utf8');
  const id = t.category('thesis', { parent_slug: 'studies' });
  expect((await t.decide(id, { decision: 'approve' })).statusCode).toBe(200);
  expect(t.area('thesis')?.parent_id).toBe(t.areaId('studies'));
  expect(readFileSync(join(t.vault, 'CLAUDE.md'), 'utf8')).toBe(before);
});

test('a failing vault write leaves the approval pending and nothing applied', async () => {
  const t = await setupApprovals();
  writeFileSync(join(t.vault, 'CLAUDE.md'), '# no areas section\n');
  const id = t.category('job-search');
  const res = await t.decide(id, { decision: 'approve' });
  expect(res.statusCode).toBe(409);
  expect(t.row(id).status).toBe('pending');
  expect(t.area('job-search')).toBeUndefined();
  expect(t.audits()).not.toContain('approval.approve');
});

test('rejecting a category changes nothing but the row', async () => {
  const t = await setupApprovals();
  const s = (t.db.prepare(`INSERT INTO sessions (filing_status) VALUES ('inbox') RETURNING id`).get() as { id: number }).id;
  t.db.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'user', 'hi')`).run(s);
  const id = t.category('job-search', { session_ids: [s] });
  expect((await t.decide(id, { decision: 'reject', final_text: 'x' })).statusCode).toBe(400);
  expect((await t.decide(id, { decision: 'reject' })).json()).toEqual({ id, status: 'rejected' });
  expect(t.area('job-search')).toBeUndefined();
  expect(t.db.prepare('SELECT COUNT(*) n FROM jobs').pluck().get()).toBe(0);
  expect(t.row(id)).toMatchObject({ final_text: null, edit_distance: null });
  expect(t.audits()).toContain('approval.reject');
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
});

test('a conflict path outside the vault is refused', async () => {
  const t = await setupApprovals();
  const id = t.propose('vault_conflict', { path: '../escape.md', current_hash: null, content: 'x' });
  expect((await t.decide(id, { decision: 'approve' })).statusCode).toBe(500);
  expect(t.row(id).status).toBe('pending');
});

test('stale proposals expire, conflicts do not', async () => {
  const t = await setupApprovals();
  const a = t.propose('persona_statement', {}, null, '2026-11-01T00:00:00.000Z');
  const b = t.propose('vault_conflict', {}, null, '2026-11-01T00:00:00.000Z');
  const c = t.propose('persona_statement', {}, null, '2026-11-10T00:00:00.000Z');
  expect(expireStale(t.db, new Date('2026-11-20T00:00:00.000Z'))).toBe(1);
  expect([a, b, c].map((id) => t.row(id).status)).toEqual(['expired', 'pending', 'pending']);
  expect(t.audits()).toContain('approval.expire');
});

test(`shows at most ${DAILY_CAP} items a day, oldest first; batch reject works`, async () => {
  const t = await setupApprovals();
  const ids = Array.from({ length: 20 }, (_, i) => t.category(`area-${i}`));
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
  const ok = t.category('job-search');
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

test('the new line never lands in a comment, and hostile text can’t break the Areas list', async () => {
  const t = await setupApprovals();
  const md = join(t.vault, 'CLAUDE.md');
  writeFileSync(md, readFileSync(md, 'utf8').replace('\n## Area modes', '<!--\n- `example` | Example | do | commented out\n-->\n\n## Area modes'));
  const id = t.category('job-search', { description: '<<!--!-- x --->-> | do | y' });
  expect((await t.decide(id, { decision: 'approve' })).statusCode).toBe(200);
  const areas = parseAreas(readFileSync(md, 'utf8'));
  expect(areas).toHaveLength(11);
  expect(areas.at(-1)).toMatchObject({ slug: 'job-search', description: '!--!-- x ---- | do | y' });

  const blank = t.category('blank', { name: '   ' }); // fails the payload schema: 500, stays pending, can still be rejected
  expect((await t.decide(blank, { decision: 'approve' })).statusCode).toBe(500);
  expect((await t.decide(blank, { decision: 'reject' })).statusCode).toBe(200);
});

test('a CRLF CLAUDE.md keeps its line endings', async () => {
  const t = await setupApprovals();
  const md = join(t.vault, 'CLAUDE.md');
  writeFileSync(md, readFileSync(md, 'utf8').replace(/\r?\n/g, '\r\n'));
  await t.decide(t.category('job-search'), { decision: 'approve' });
  const text = readFileSync(md, 'utf8');
  expect(text).toContain('- `job-search` | Job search | do | Applying for jobs\r\n');
  expect(text.replace(/\r\n/g, '')).not.toContain('\n');
});

test('a missing CLAUDE.md is a 409 with a reason, and the row stays pending', async () => {
  const t = await setupApprovals();
  rmSync(join(t.vault, 'CLAUDE.md'));
  const id = t.category('job-search');
  const res = await t.decide(id, { decision: 'approve' });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/CLAUDE\.md is missing/);
  expect(t.row(id).status).toBe('pending');
});

test('a malformed conflict payload can still be rejected; over-long originals can’t be edited', async () => {
  const t = await setupApprovals();
  const bad = t.propose('vault_conflict', { nope: true });
  expect((await t.decide(bad, { decision: 'reject' })).json()).toEqual({ id: bad, status: 'rejected' });
  const long = t.propose('propose_category', { slug: 'x' }, 'a'.repeat(5000));
  expect((await t.decide(long, { decision: 'approve', final_text: 'b' })).statusCode).toBe(400);
});
