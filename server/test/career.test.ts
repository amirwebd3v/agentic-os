import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { claimNext, enqueue, fail, recoverStaleLocks } from '../src/db/jobs.ts';
import { careerRoutes, failCareerJob, failStuckApplications, MAX_POSTING_CHARS } from '../src/http/routes/career.ts';
import { runNext, startRunner } from '../src/jobs/runner.ts';
import type { JobHandler } from '../src/jobs/runner.ts';
import { reloadLlm } from '../src/llm/client.ts';
import { buildTestApp } from './helpers.ts';

const secret = vi.hoisted(() => ({ key: 'sk-test' as string | null }));
vi.mock('../src/secrets.ts', () => ({ getSecret: () => secret.key }));

const POSTING = 'Canary-7f3a Senior Engineer at Example GmbH, must know Rust.';
const dirs: string[] = [];
beforeEach(() => {
  secret.key = 'sk-test';
  reloadLlm();
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup({ master = true } = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'aos-career-'));
  dirs.push(vault);
  if (master) {
    mkdirSync(join(vault, 'career'));
    writeFileSync(join(vault, 'career', 'master.md'), '## Summary\n');
  }
  const t = await buildTestApp({ loggedIn: true, plugins: [careerRoutes({ vaultDir: vault })] });
  const post = (payload: unknown) => t.app.inject(t.authed({ method: 'POST', url: '/api/career/applications', payload: payload as object }));
  const get = async (id: number) => (await t.app.inject(t.authed({ url: `/api/career/applications/${id}` }))).json() as Record<string, unknown>;
  const start = async () => ((await post({ posting: POSTING })).json() as { id: number }).id;
  const dump = () => JSON.stringify(t.db.prepare('SELECT * FROM jobs').all()) + JSON.stringify(t.db.prepare('SELECT * FROM audit_log').all());
  return { ...t, vault, post, get, start, dump };
}

test('a career job fails on its first throw, other kinds requeue', async () => {
  const t = await setup();
  enqueue(t.db, 'career_intake', 'c', { applicationId: 1 });
  enqueue(t.db, 'other', 'o', {});
  expect(fail(t.db, claimNext(t.db)!.id, 'Error')).toBe(true);
  expect(fail(t.db, claimNext(t.db)!.id, 'Error')).toBe(false);
  expect(t.db.prepare('SELECT kind, status, attempts FROM jobs ORDER BY id').all()).toEqual([
    { kind: 'career_intake', status: 'failed', attempts: 1 },
    { kind: 'other', status: 'queued', attempts: 1 },
  ]);
});

test('POST validates, stores the posting, enqueues intake with ids only, audits counts only', async () => {
  const t = await setup();
  expect((await t.post({})).statusCode).toBe(400);
  expect((await t.post({ posting: '' })).statusCode).toBe(400);
  expect((await t.post({ posting: { text: 'x' } })).statusCode).toBe(400);
  expect(t.db.prepare('SELECT count(*) FROM applications').pluck().get()).toBe(0);
  const long = await t.post({ posting: 'x'.repeat(MAX_POSTING_CHARS + 1) });
  expect([long.statusCode, long.json()]).toEqual([400, { error: 'posting_too_long' }]);
  secret.key = null;
  const noProvider = await t.post({ posting: POSTING });
  expect([noProvider.statusCode, noProvider.json()]).toEqual([409, { error: 'provider_not_configured' }]);
  secret.key = 'sk-test';

  const res = await t.post({ posting: 'x'.repeat(MAX_POSTING_CHARS - 1) + 'é' });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toMatchObject({ status: 'processing', step: 'intake', fail_code: null, company: null });
  const id = (res.json() as { id: number }).id;
  expect(t.db.prepare('SELECT kind, body FROM application_texts WHERE application_id = ?').get(id)).toMatchObject({ kind: 'posting' });
  expect(t.db.prepare('SELECT master_hash FROM applications WHERE id = ?').pluck().get(id)).toMatch(/^[0-9a-f]{64}$/);
  expect(t.db.prepare('SELECT kind, idempotency_key, payload FROM jobs').get()).toEqual({
    kind: 'career_intake', idempotency_key: `career:intake:${id}:0`, payload: JSON.stringify({ applicationId: id }),
  });
  const auditRow = t.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'career.application.create'").pluck().get();
  expect(JSON.parse(auditRow as string)).toEqual({ id, chars: MAX_POSTING_CHARS });

  const list = await t.app.inject(t.authed({ url: '/api/career/applications' }));
  expect((list.json() as { id: number }[]).map((a) => a.id)).toEqual([id]);
  expect(await t.get(id)).toMatchObject({ id, requirements: null, coverage: null, draft: null, verify: null, files: [] });
  expect((await t.app.inject(t.authed({ url: '/api/career/applications/999' }))).json()).toEqual({ error: 'not_found' });
});

test('POST without a master is master_missing', async () => {
  const t = await setup({ master: false });
  const res = await t.post({ posting: POSTING });
  expect([res.statusCode, res.json()]).toEqual([409, { error: 'master_missing' }]);
});

test('a throwing career handler ends failed/internal within one runner tick, with no posting text anywhere', async () => {
  const t = await setup();
  const id = await t.start();
  const handlers: Record<string, JobHandler> = {
    career_intake: async () => {
      throw new Error(`could not parse: ${POSTING}`); // the kind of message the contract forbids; the runner must not keep it
    },
  };
  const errors: unknown[] = [];
  const stop = startRunner(t.db, handlers, (e) => errors.push(e), (job) => failCareerJob(t.db, job), 10);
  await vi.waitFor(() => expect(t.db.prepare('SELECT status FROM jobs').pluck().get()).toBe('failed'));
  await stop();
  expect(await t.get(id)).toMatchObject({ status: 'failed', step: 'intake', fail_code: 'internal' });
  expect(t.db.prepare('SELECT error, attempts FROM jobs').get()).toEqual({ error: 'Error', attempts: 1 });
  expect(String(errors[0])).not.toContain('Canary');
  expect(t.dump()).not.toContain('Canary');
  expect(t.db.prepare("SELECT kind, detail FROM application_events WHERE kind = 'failed'").get()).toEqual({ kind: 'failed', detail: '{"code":"internal"}' });
});

test('a career job failed by stale-lock recovery is swept on boot', async () => {
  const t = await setup();
  const id = await t.start();
  failStuckApplications(t.db); // what careerRoutes runs on registration
  expect((await t.get(id)).status).toBe('processing'); // its job is still queued
  claimNext(t.db);
  t.db.prepare("UPDATE jobs SET locked_at = '2000-01-01T00:00:00.000Z'").run();
  recoverStaleLocks(t.db);
  expect(t.db.prepare('SELECT status FROM jobs').pluck().get()).toBe('failed'); // one attempt, no requeue
  failStuckApplications(t.db);
  expect(await t.get(id)).toMatchObject({ status: 'failed', fail_code: 'internal' });
  failStuckApplications(t.db);
  expect(t.db.prepare("SELECT count(*) FROM application_events WHERE kind = 'failed'").pluck().get()).toBe(1);
});

test("a due job of another kind starts before the run's next step", async () => {
  const t = await setup();
  const id = await t.start();
  enqueue(t.db, 'other', 'other-1', {});
  const ran: string[] = [];
  const handlers: Record<string, JobHandler> = {
    career_intake: async () => {
      ran.push('career_intake');
      enqueue(t.db, 'career_match', `career:match:${id}:0`, { applicationId: id });
    },
    career_match: async () => void ran.push('career_match'),
    other: async () => void ran.push('other'),
  };
  while (await runNext(t.db, handlers));
  expect(ran).toEqual(['career_intake', 'other', 'career_match']);
});

// ---------- W2-08: PATCH …/draft, edited_refs and sources ----------

const N = 'exp-northwind-logistics-2021';
const SECRET = 'Canary-9d1e my own words';
const DRAFT = {
  summary: { text: 'Platform engineer, 6 years.', cites: ['sum-1'] },
  entries: [{ entry_id: N, bullets: [{ text: 'Cut deploy time to 9 minutes.', cites: [`${N}-1a2b3c`] }, { text: 'Terraform on AWS.', cites: [`${N}-4d5e6f`, 'gone-1'] }] }],
  skill_ids: ['skill-aws'],
  letter: { paragraphs: [{ text: 'P0', cites: ['sum-1'] }, { text: 'P1', cites: ['sum-1'] }, { text: 'P2', cites: ['sum-1'] }] },
  versions: 1,
};

async function drafted(status = 'draft_ready') {
  const t = await setup();
  copyFileSync(join(import.meta.dirname, 'fixtures', 'career', 'master.md'), join(t.vault, 'career', 'master.md'));
  const id = await t.start();
  t.db.prepare('UPDATE applications SET status = ?, step = ? WHERE id = ?').run(status, 'verify', id);
  t.db.prepare(`INSERT INTO application_texts (application_id, kind, body) VALUES (?, 'draft', ?)`).run(id, JSON.stringify(DRAFT));
  const patch = (edits: unknown, app = id) =>
    t.app.inject(t.authed({ method: 'PATCH', url: `/api/career/applications/${app}/draft`, payload: { edits } as object }));
  return { ...t, id, patch };
}

test('the detail route gives the master text behind every cite and entry, and nothing it no longer has', async () => {
  const t = await drafted();
  const d = await t.get(t.id);
  expect(d.sources).toEqual({
    'sum-1': 'Platform engineer with 6 years in DevOps and cloud infrastructure.',
    [N]: 'Northwind Logistics | DevOps Engineer | 2021-03 – present',
    [`${N}-1a2b3c`]: 'Cut deploy time from 40 to 9 minutes by moving CI to GitHub Actions.',
    [`${N}-4d5e6f`]: 'Automated AWS infrastructure (ECS, RDS, IAM) with Terraform across 3 accounts.',
    'skill-aws': 'AWS',
  });
  expect(d.edited_refs).toEqual([]);
  rmSync(join(t.vault, 'career', 'master.md'));
  expect((await t.get(t.id)).sources).toEqual({});
});

test('PATCH …/draft validates, refuses a wrong status or ref, stores a new version, and logs no text', async () => {
  const t = await drafted();
  const invalid = [
    [],
    Array.from({ length: 51 }, () => ({ ref: 'letter.0', text: 'x' })),
    [{ ref: 'letter.0', text: '' }],
    [{ ref: 'letter.0', text: 'x'.repeat(701) }],
    [{ ref: 'letter.0' }],
  ];
  for (const bad of invalid) expect((await t.patch(bad)).statusCode).toBe(400);
  for (const ref of ['letter.3', 'cv.entries.exp-other-2020.0', `cv.entries.${N}.2`, 'cv.skills', 'cv', '__proto__', `cv.entries.${N}.-1`]) {
    const res = await t.patch([{ ref: 'letter.0', text: 'fine' }, { ref, text: SECRET }]);
    expect([res.statusCode, res.json()]).toEqual([400, { error: 'bad_ref' }]);
  }
  expect((await t.patch([{ ref: 'letter.0', text: 'x' }], 999)).json()).toEqual({ error: 'not_found' });
  expect(t.db.prepare("SELECT count(*) FROM application_texts WHERE kind = 'draft'").pluck().get()).toBe(1); // nothing half-applied

  const res = await t.patch([
    { ref: `cv.entries.${N}.1`, text: SECRET },
    { ref: 'cv.summary', text: 'Platform engineer, six years.' },
    { ref: 'letter.2', text: 'x'.repeat(700) },
  ]);
  expect(res.statusCode).toBe(200);
  const d = res.json() as { draft: typeof DRAFT; edited_refs: string[] };
  expect(d.draft.versions).toBe(2);
  expect(d.draft.entries[0]!.bullets[1]).toEqual({ text: SECRET, cites: [`${N}-4d5e6f`, 'gone-1'] });
  expect(d.draft.entries[0]!.bullets[0]!.text).toBe('Cut deploy time to 9 minutes.');
  expect(d.edited_refs).toEqual([`cv.entries.${N}.1`, 'cv.summary', 'letter.2']);
  await t.patch([{ ref: 'letter.2', text: 'again' }, { ref: 'letter.0', text: 'P0!' }]);
  const again = await t.get(t.id);
  expect((again.draft as typeof DRAFT).versions).toBe(3);
  expect(again.edited_refs).toEqual([`cv.entries.${N}.1`, 'cv.summary', 'letter.2', 'letter.0']);
  expect(t.db.prepare("SELECT version FROM application_texts WHERE application_id = ? AND kind = 'draft' ORDER BY version").pluck().all(t.id)).toEqual([1, 2, 3]);

  const event = JSON.parse(t.db.prepare("SELECT detail FROM application_events WHERE kind = 'edited' ORDER BY id LIMIT 1").pluck().get() as string);
  expect(event).toMatchObject({ lines: 3, version: 2, refs: [`cv.entries.${N}.1`, 'cv.summary', 'letter.2'] });
  expect(event.edit_distance).toBeGreaterThan(0);
  expect(event.edit_distance).toBeLessThanOrEqual(1);
  const audits = t.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'career.application.edit'").pluck().all() as string[];
  expect(audits.map((a) => Object.keys(JSON.parse(a)).sort())).toEqual([0, 1].map(() => ['edit_distance', 'id', 'lines', 'version']));
  const everything = t.dump() + JSON.stringify(t.db.prepare('SELECT * FROM application_events').all());
  expect(everything).not.toContain('Canary-9d1e');
  expect(everything).not.toContain('six years');
});

test.each(['processing', 'failed', 'final', 'applied', 'withdrawn'])('PATCH …/draft on a %s application is wrong_status', async (status) => {
  const t = await drafted(status);
  const res = await t.patch([{ ref: 'letter.0', text: 'x' }]);
  expect([res.statusCode, res.json()]).toEqual([409, { error: 'wrong_status' }]);
});

test('a flagged draft can be edited', async () => {
  const t = await drafted('flagged');
  expect((await t.patch([{ ref: 'letter.1', text: 'mine' }])).statusCode).toBe(200);
});
