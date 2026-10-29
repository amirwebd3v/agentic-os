import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Draft } from '../src/career/tailor.ts';
import { claimNext, enqueue, fail, recoverStaleLocks } from '../src/db/jobs.ts';
import { careerRoutes, failCareerJob, failStuckApplications, MAX_POSTING_CHARS } from '../src/http/routes/career.ts';
import { outRoot } from '../src/jobs/career-render.ts';
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
  const t = await buildTestApp({ loggedIn: true, plugins: [careerRoutes({ vaultDir: vault, dataDir: vault })] });
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
    [N]: 'Northwind Logistics | DevOps Engineer | 2021-03 | present | Hamburg',
    [`${N}-1a2b3c`]: 'Cut deploy time from 40 to 9 minutes by moving CI to GitHub Actions.',
    [`${N}-4d5e6f`]: 'Automated AWS infrastructure (ECS, RDS, IAM) with Terraform across 3 accounts.',
    'skill-aws': 'AWS',
  });
  expect(d.languages).toEqual(['English (C1)', 'German (native)']);
  expect(d.edited_refs).toEqual([]);
  rmSync(join(t.vault, 'career', 'master.md'));
  expect(await t.get(t.id)).toMatchObject({ sources: {}, languages: [] });
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
  for (const ref of ['letter.3', 'cv.entries.exp-other-2020.0', `cv.entries.${N}.2`, 'cv.skill', 'cv', '__proto__', `cv.entries.${N}.-1`]) {
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

test('PATCH …/draft ops: headers, skills, languages, add and remove; refs stay stable; no text in events or audit', async () => {
  const t = await drafted();
  const res = await t.patch([
    { op: 'set', ref: `cv.entries.${N}.header.title`, text: 'Canary-h1 Platform Lead' },
    { op: 'remove', ref: `cv.entries.${N}.header.location` },
    { ref: 'cv.skills', text: 'Terraform, Canary-s1' },
    { op: 'set', ref: 'cv.languages', text: 'English, German' },
    { op: 'remove', ref: `cv.entries.${N}.0` },
    { op: 'add', ref: `cv.entries.${N}`, text: 'Canary-a1 added bullet' },
    { op: 'remove', ref: 'letter.1' },
    { op: 'add', ref: 'letter', text: 'Canary-a2 added paragraph' },
  ]);
  expect(res.statusCode).toBe(200);
  const d = res.json() as { draft: Draft; edited_refs: string[] };
  const e = d.draft.entries[0]!;
  expect(e.header).toEqual({ title: 'Canary-h1 Platform Lead', location: '' });
  expect(e.bullets.map((b) => [b.text, b.removed])).toEqual([
    ['Cut deploy time to 9 minutes.', true], // stays in place, so `.1` is still the same line
    ['Terraform on AWS.', undefined],
    ['Canary-a1 added bullet', undefined],
  ]);
  expect(e.bullets[2]!.cites).toEqual([]);
  expect(d.draft.letter.paragraphs.map((p) => p.removed ?? false)).toEqual([false, true, false, false]);
  expect([d.draft.skills_text, d.draft.languages_text, d.draft.versions]).toEqual(['Terraform, Canary-s1', 'English, German', 2]);
  expect(d.edited_refs).toEqual([
    `cv.entries.${N}.header.title`, `cv.entries.${N}.header.location`, 'cv.skills', 'cv.languages', `cv.entries.${N}.0`, `cv.entries.${N}.2`, 'letter.1', 'letter.3',
  ]);

  // A removed line, a removed entry and its lines are gone for every op; one bad op rejects the whole batch.
  for (const edit of [
    { ref: `cv.entries.${N}.0`, text: 'again' },
    { op: 'remove', ref: 'letter.1' },
    { op: 'add', ref: 'cv.summary', text: 'x' },
    { op: 'add', ref: 'letter.0', text: 'x' },
    { op: 'set', ref: 'letter', text: 'x' },
    { op: 'remove', ref: 'cv.skills' },
    { op: 'set', ref: `cv.entries.${N}`, text: 'x' },
    { ref: `cv.entries.${N}.header.salary`, text: 'x' },
    { ref: `cv.entries.${N}.header.__proto__`, text: 'x' },
    { ref: 'cv.entries.__proto__.header.org', text: 'x' },
    { op: 'add', ref: 'cv.entries.__proto__', text: 'x' },
  ]) {
    const bad = await t.patch([{ ref: 'letter.0', text: 'fine' }, edit]);
    expect([bad.statusCode, bad.json()]).toEqual([400, { error: 'bad_ref' }]);
  }
  for (const edit of [
    { ref: `cv.entries.${N}.header.org`, text: 'x'.repeat(121) },
    { op: 'add', ref: 'letter' },
    { op: 'remove', ref: 'letter.0', text: 'x' },
  ]) {
    const bad = await t.patch([{ ref: 'letter.0', text: 'fine' }, edit]);
    expect([bad.statusCode, bad.json()]).toEqual([400, { error: 'bad_edit' }]);
  }
  expect((await t.patch([{ op: 'replace', ref: 'letter.0', text: 'x' }])).statusCode).toBe(400);
  expect(t.db.prepare("SELECT count(*) FROM application_texts WHERE kind = 'draft'").pluck().get()).toBe(2);

  const header = await t.patch([{ ref: `cv.entries.${N}.header.org`, text: 'x'.repeat(120) }, { op: 'remove', ref: `cv.entries.${N}` }]);
  const after = header.json() as { draft: Draft };
  expect(after.draft.entries[0]).toMatchObject({ removed: true, header: { org: 'x'.repeat(120), title: 'Canary-h1 Platform Lead', location: '' } });
  expect(after.draft.versions).toBe(3);
  expect((await t.patch([{ op: 'add', ref: `cv.entries.${N}`, text: 'x' }])).json()).toEqual({ error: 'bad_ref' });

  const events = t.db.prepare("SELECT detail FROM application_events WHERE kind = 'edited' ORDER BY id").pluck().all() as string[];
  expect(JSON.parse(events[0]!)).toMatchObject({ lines: 8, version: 2, edit_distance: 1 }); // two model lines removed
  expect(JSON.parse(events[1]!)).toMatchObject({ lines: 2, version: 3, edit_distance: null }); // no model line touched
  const everything = t.dump() + JSON.stringify(t.db.prepare('SELECT * FROM application_events').all());
  expect(everything).not.toContain('Canary-');
  expect(everything).not.toContain('English, German');
});

test('PATCH …/draft restore and add: removed items come back, a summary and master entries can be added', async () => {
  const t = await drafted();
  const K = 'exp-kestrel-data-2018';
  expect((await t.get(t.id)).master_entries).toEqual([
    { id: N, header: 'Northwind Logistics | DevOps Engineer | 2021-03 | present | Hamburg' },
    { id: K, header: 'Kestrel Data | Systems Administrator | 2018-09 | 2021-02 | Bremen' },
    { id: 'edu-hochschule-bremen-2015', header: 'Hochschule Bremen | BSc Computer Science | 2015 | 2018 | Bremen' },
  ]);
  await t.patch([{ op: 'remove', ref: 'cv.summary' }, { op: 'remove', ref: `cv.entries.${N}.0` }, { op: 'remove', ref: 'letter.1' }]);
  for (const edit of [
    { op: 'restore', ref: `cv.entries.${N}.1` }, // not removed
    { op: 'restore', ref: `cv.entries.${N}` },
    { op: 'restore', ref: 'letter.9' },
    { op: 'restore', ref: 'cv.skills' },
    { op: 'add', ref: 'cv.entries', text: N }, // already in the draft
    { op: 'add', ref: 'cv.entries', text: 'exp-nowhere-2020' },
    { op: 'add', ref: 'cv.entries', text: `${N}-1a2b3c` }, // a bullet, not an entry
  ]) {
    const bad = await t.patch([{ ref: 'letter.0', text: 'fine' }, edit]);
    expect([bad.statusCode, bad.json()]).toEqual([400, { error: 'bad_ref' }]);
  }
  expect((await t.patch([{ op: 'restore', ref: 'letter.1', text: 'x' }])).json()).toEqual({ error: 'bad_edit' });

  const res = await t.patch([
    { op: 'restore', ref: `cv.entries.${N}.0` },
    { op: 'restore', ref: 'letter.1' },
    { op: 'add', ref: 'cv.summary', text: 'Canary-s1 mine' },
    { op: 'add', ref: 'cv.entries', text: K },
    { op: 'add', ref: `cv.entries.${K}`, text: 'Canary-b1 bullet' },
  ]);
  expect(res.statusCode).toBe(200);
  const d = res.json() as { draft: Draft; edited_refs: string[] };
  expect(d.draft.summary).toEqual({ text: 'Canary-s1 mine', cites: [] });
  expect(d.draft.entries[0]!.bullets[0]).toEqual(DRAFT.entries[0]!.bullets[0]);
  expect(d.draft.letter.paragraphs[1]).toEqual(DRAFT.letter.paragraphs[1]);
  expect(d.draft.entries[1]).toEqual({ entry_id: K, bullets: [{ text: 'Canary-b1 bullet', cites: [] }] });
  expect(d.edited_refs).toEqual(expect.arrayContaining(['cv.summary', `cv.entries.${K}`, `cv.entries.${K}.0`]));
  expect((await t.patch([{ op: 'add', ref: 'cv.summary', text: 'x' }])).json()).toEqual({ error: 'bad_ref' }); // live now: `set` it

  await t.patch([{ op: 'remove', ref: `cv.entries.${K}` }]);
  expect((await t.patch([{ op: 'add', ref: 'cv.entries', text: K }])).json()).toEqual({ error: 'bad_ref' }); // restore it instead
  expect(((await t.patch([{ op: 'restore', ref: `cv.entries.${K}` }])).json() as { draft: Draft }).draft.entries[1]!.removed).toBeUndefined();
  expect(t.dump() + JSON.stringify(t.db.prepare('SELECT * FROM application_events').all())).not.toContain('Canary-');
});

// ---------- admin: rename, retry, archive, delete ----------

type T = Awaited<ReturnType<typeof setup>>;
const call = (t: T, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  t.app.inject(t.authed({ method, url: `/api/career/applications${url}`, ...(payload && { payload }) }));
const make = (t: T, status: string, step: string | null = null, hash = 'h') =>
  Number(t.db.prepare('INSERT INTO applications (status, step, master_hash) VALUES (?, ?, ?)').run(status, step, hash).lastInsertRowid);
const eventsOf = (t: T, id: number) => t.db.prepare('SELECT kind, detail FROM application_events WHERE application_id = ? ORDER BY id').all(id);

test('PATCH renames in any status but processing, trimmed; the event and audit name the fields, never the values', async () => {
  const t = await setup();
  const id = make(t, 'draft_ready');
  for (const bad of [{}, { company: ' ' }, { company: 'x'.repeat(201) }, { follow_up_on: 'soon' }]) expect([bad, (await call(t, 'PATCH', `/${id}`, bad)).statusCode]).toEqual([bad, 400]);
  const res = await call(t, 'PATCH', `/${id}`, { company: ' Canary-r1 Acme ', role_title: 'Canary-r2 Dev' });
  expect(res.json()).toMatchObject({ company: 'Canary-r1 Acme', role_title: 'Canary-r2 Dev', follow_up_on: null });
  const busy = make(t, 'processing', 'match');
  expect((await call(t, 'PATCH', `/${busy}`, { role_title: 'X' })).json()).toEqual({ error: 'wrong_status' });
  expect((await call(t, 'PATCH', `/${busy}`, { follow_up_on: '2026-11-03' })).statusCode).toBe(200);
  expect(eventsOf(t, id)).toEqual([{ kind: 'edited', detail: '{"fields":["company","role_title"]}' }]);
  const audits = t.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'career.application.rename'").pluck().all() as string[];
  expect(audits.map((a) => JSON.parse(a))).toEqual([{ id, fields: ['company', 'role_title'] }]);
  expect(t.dump()).not.toContain('Canary-r');
});

test('retry: only a failed run, with the same preconditions as POST; it resets the run and queues a new intake', async () => {
  const t = await setup();
  const id = await t.start();
  expect((await call(t, 'POST', `/${id}/retry`)).json()).toEqual({ error: 'wrong_status' }); // processing
  expect((await call(t, 'POST', `/${make(t, 'failed', null, '')}/retry`)).json()).toEqual({ error: 'wrong_status' }); // sent elsewhere
  expect((await call(t, 'POST', '/999/retry')).statusCode).toBe(404);
  t.db.prepare(`UPDATE applications SET status = 'failed', step = 'draft', fail_code = 'provider_error', master_hash = 'old' WHERE id = ?`).run(id);
  secret.key = null;
  expect((await call(t, 'POST', `/${id}/retry`)).json()).toEqual({ error: 'provider_not_configured' });
  secret.key = 'sk-test';
  rmSync(join(t.vault, 'career', 'master.md'));
  expect((await call(t, 'POST', `/${id}/retry`)).json()).toEqual({ error: 'master_missing' });
  writeFileSync(join(t.vault, 'career', 'master.md'), '## Summary\n');

  const res = await call(t, 'POST', `/${id}/retry`);
  expect(res.statusCode).toBe(202);
  expect(res.json()).toMatchObject({ id, status: 'processing', step: 'intake', fail_code: null });
  expect(t.db.prepare('SELECT master_hash FROM applications WHERE id = ?').pluck().get(id)).toMatch(/^[0-9a-f]{64}$/);
  expect(t.db.prepare('SELECT idempotency_key FROM jobs ORDER BY id').pluck().all()).toEqual([`career:intake:${id}:0`, `career:intake:${id}:1`]);
  expect(eventsOf(t, id).at(-1)).toEqual({ kind: 'retry', detail: '{"to":"intake"}' });
  expect((await call(t, 'POST', `/${id}/retry`)).json()).toEqual({ error: 'wrong_status' });
});

test('archive and restore; archive and delete are refused while a step runs', async () => {
  const t = await setup();
  for (const [status, step] of [['processing', 'draft'], ['final', 'render']] as const) {
    const busy = make(t, status, step);
    expect((await call(t, 'POST', `/${busy}/archive`, { archived: true })).json()).toEqual({ error: 'wrong_status' });
    expect((await call(t, 'DELETE', `/${busy}`)).json()).toEqual({ error: 'wrong_status' });
  }
  const id = make(t, 'failed');
  expect((await call(t, 'POST', `/${id}/archive`, { archived: 'yes' })).statusCode).toBe(400);
  const archived = (await call(t, 'POST', `/${id}/archive`, { archived: true })).json() as { archived_at: string | null };
  expect(archived.archived_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  const list = (await call(t, 'GET', '')).json() as { id: number; archived_at: string | null }[];
  expect(list.find((a) => a.id === id)?.archived_at).toBe(archived.archived_at); // still listed: the UI filters
  expect(((await call(t, 'POST', `/${id}/archive`, { archived: false })).json() as { archived_at: null }).archived_at).toBeNull();
  expect(eventsOf(t, id)).toEqual([{ kind: 'status', detail: '{"archived":true}' }, { kind: 'status', detail: '{"archived":false}' }]);
});

test('delete is permanent: texts, milestones, files and names go, queued jobs fail, and every route 404s', async () => {
  const t = await setup();
  const id = make(t, 'final');
  t.db.prepare(`UPDATE applications SET company = 'Canary-d1', role_title = 'Canary-d2', follow_up_on = '2026-11-03' WHERE id = ?`).run(id);
  t.db.prepare(`INSERT INTO application_texts (application_id, kind, body) VALUES (?, 'posting', 'Canary-d3')`).run(id);
  t.db.prepare(`INSERT INTO application_milestones (application_id, kind, on_date, note) VALUES (?, 'applied', '2026-10-01', 'Canary-d4')`).run(id);
  t.db.prepare(`INSERT INTO application_files (application_id, kind, relpath, sha256, bytes) VALUES (?, 'cv_docx', ?, 'x', 1)`).run(id, `${id}/cv.docx`);
  const dir = join(outRoot(t.vault), String(id));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cv.docx'), 'x');
  enqueue(t.db, 'career_render', `career:render:${id}:0`, { applicationId: id });
  const other = make(t, 'final');

  expect((await call(t, 'DELETE', `/${id}`)).statusCode).toBe(204);
  expect(existsSync(dir)).toBe(false);
  for (const table of ['application_texts', 'application_milestones', 'application_files'])
    expect(t.db.prepare(`SELECT count(*) FROM ${table} WHERE application_id = ?`).pluck().get(id)).toBe(0);
  expect(t.db.prepare('SELECT company, role_title, follow_up_on, deleted_at IS NOT NULL AS gone FROM applications WHERE id = ?').get(id)).toEqual({
    company: null, role_title: null, follow_up_on: null, gone: 1,
  });
  expect(eventsOf(t, id)).toEqual([{ kind: 'status', detail: '{"deleted":true}' }]);
  expect(t.db.prepare('SELECT status FROM jobs').pluck().get()).toBe('failed');
  expect(((await call(t, 'GET', '')).json() as { id: number }[]).map((a) => a.id)).toEqual([other]);
  const routes: [Parameters<typeof call>[1], string, object?][] = [
    ['GET', `/${id}`], ['PATCH', `/${id}`, { follow_up_on: null }], ['DELETE', `/${id}`], ['POST', `/${id}/retry`], ['POST', `/${id}/archive`, { archived: true }],
    ['PATCH', `/${id}/draft`, { edits: [{ ref: 'letter.0', text: 'x' }] }], ['POST', `/${id}/final`], ['POST', `/${id}/render`], ['GET', `/${id}/files/cv_docx`],
    ['GET', `/${id}/milestones`], ['POST', `/${id}/milestones`, { kind: 'note', on_date: '2026-10-01' }],
  ];
  for (const [method, url, body] of routes) expect([method, url, (await call(t, method, url, body)).statusCode]).toEqual([method, url, 404]);
  expect(JSON.parse(t.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'career.application.delete'").pluck().get() as string)).toEqual({ id, texts: 1, milestones: 1, files: 1 });
  expect(t.dump() + JSON.stringify(eventsOf(t, id))).not.toContain('Canary-d');
});
