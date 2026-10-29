import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Draft } from '../src/career/draft.ts';
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

// ---------- career v2 §1: PUT …/draft, edited_refs and sources ----------

const N = 'exp-northwind-logistics-2021';
const K = 'exp-kestrel-data-2018';
const SECRET = 'Canary-9d1e my own words';
/** Stored in the v1 shape: every route reads it as v2 (`toDraftV2`). Its v2 ids, in master section order: summary l-1;
 * Northwind e-1 (l-2, l-3); skills l-4; languages l-5, l-6 (the master's); letter l-7, l-8, l-9. */
const DRAFT = {
  summary: { text: 'Platform engineer, 6 years.', cites: ['sum-1'] },
  entries: [{ entry_id: N, bullets: [{ text: 'Cut deploy time to 9 minutes.', cites: [`${N}-1a2b3c`] }, { text: 'Terraform on AWS.', cites: [`${N}-4d5e6f`, 'gone-1'] }] }],
  skill_ids: ['skill-aws'],
  letter: { paragraphs: [{ text: 'P0', cites: ['sum-1'] }, { text: 'P1', cites: ['sum-1'] }, { text: 'P2', cites: ['sum-1'] }] },
  versions: 1,
};
type Sections = Draft['cv']['sections'];
type EntrySection = Extract<Sections[number], { entries: unknown }>;
type BulletSection = Extract<Sections[number], { bullets: unknown }>;

async function drafted(status = 'draft_ready') {
  const t = await setup();
  copyFileSync(join(import.meta.dirname, 'fixtures', 'career', 'master.md'), join(t.vault, 'career', 'master.md'));
  const id = await t.start();
  t.db.prepare('UPDATE applications SET status = ?, step = ? WHERE id = ?').run(status, 'verify', id);
  t.db.prepare(`INSERT INTO application_texts (application_id, kind, body) VALUES (?, 'draft', ?)`).run(id, JSON.stringify(DRAFT));
  const put = (payload: unknown, app = id) => t.app.inject(t.authed({ method: 'PUT', url: `/api/career/applications/${app}/draft`, payload: payload as object }));
  const draft = async () => (await t.get(id)).draft as Draft;
  const versions = () => t.db.prepare("SELECT version FROM application_texts WHERE application_id = ? AND kind = 'draft' ORDER BY version").pluck().all(id);
  const everything = () => t.dump() + JSON.stringify(t.db.prepare('SELECT * FROM application_events').all());
  return { ...t, id, put, draft, versions, everything };
}
const section = <S extends Sections[number]>(d: Draft, name: string) => d.cv.sections.find((s) => s.name === name) as S;

test('the detail route gives the draft as v2, and the master text behind every cite and entry, and nothing it no longer has', async () => {
  const t = await drafted();
  const d = await t.get(t.id);
  expect(d.draft).toMatchObject({ v: 2, versions: 1, letter: { paragraphs: [{ id: 'l-7', text: 'P0', cites: ['sum-1'], origin: 'model' }, { id: 'l-8' }, { id: 'l-9' }] } });
  expect((d.draft as Draft).cv.sections.map((s) => s.name)).toEqual(['Summary', 'Experience', 'Skills', 'Languages']);
  expect(d.sources).toEqual({
    'sum-1': 'Platform engineer with 6 years in DevOps and cloud infrastructure.',
    [N]: 'Northwind Logistics | DevOps Engineer | 2021-03 | present | Hamburg',
    [`${N}-1a2b3c`]: 'Cut deploy time from 40 to 9 minutes by moving CI to GitHub Actions.',
    [`${N}-4d5e6f`]: 'Automated AWS infrastructure (ECS, RDS, IAM) with Terraform across 3 accounts.',
    'skill-aws': 'AWS',
    'lang-english': 'English (C1)',
    'lang-german': 'German (native)',
  });
  expect(d.languages).toEqual(['English (C1)', 'German (native)']);
  expect(d.edited_refs).toEqual([]);
  rmSync(join(t.vault, 'career', 'master.md'));
  expect(await t.get(t.id)).toMatchObject({ sources: {}, languages: [] });
});

test('PUT …/draft: reorder, edit, delete, add an owner entry and lines; the server owns ids, cites, origin and source; edited_refs by line id; no text logged', async () => {
  const t = await drafted();
  const d = await t.draft();
  const north = section<EntrySection>(d, 'Experience').entries[0]!;
  const [l2, l3] = north.bullets;
  const [l7, , l9] = d.letter.paragraphs;
  const res = await t.put({
    versions: 1,
    cv: {
      sections: [
        section(d, 'Skills'), // moved first; the summary is gone
        {
          name: 'Experience',
          entries: [
            { ...north, bullets: [{ ...l3, text: SECRET, cites: ['sum-1'], origin: 'owner' }, l2] }, // reordered; client cites and origin ignored
            { id: 'e-77', source: 'exp-nowhere-2020', org: 'Canary-o1 Own Co', title: 'Founder', start: '2020', end: 'present', location: '', bullets: [{ id: 'l-99', text: 'Canary-o2 built it', cites: ['sum-1'], origin: 'model' }] },
            { source: K, org: 'Kestrel Data', title: 'Canary-o3 Admin', start: '2018-09', end: '2021-02', location: 'Bremen', bullets: [] },
          ],
        },
        section(d, 'Languages'),
      ],
    },
    letter: { paragraphs: [l7, { ...l9, text: 'Canary-p2 changed' }, { text: 'Canary-p3 from a gap', origin: 'suggestion' }] },
  });
  expect(res.statusCode).toBe(200);
  const after = res.json() as { draft: Draft; edited_refs: string[] };
  expect(after.draft.versions).toBe(2);
  expect(after.draft.cv.sections.map((s) => s.name)).toEqual(['Skills', 'Experience', 'Languages']);
  expect(section<EntrySection>(after.draft, 'Experience').entries).toEqual([
    { ...north, bullets: [{ ...l3, text: SECRET }, l2] },
    { id: 'e-2', org: 'Canary-o1 Own Co', title: 'Founder', start: '2020', end: 'present', location: '', bullets: [{ id: 'l-10', text: 'Canary-o2 built it', cites: [], origin: 'owner' }] },
    { id: 'e-3', source: K, org: 'Kestrel Data', title: 'Canary-o3 Admin', start: '2018-09', end: '2021-02', location: 'Bremen', bullets: [] },
  ]);
  expect(after.draft.letter.paragraphs).toEqual([l7, { ...l9, text: 'Canary-p2 changed' }, { id: 'l-11', text: 'Canary-p3 from a gap', cites: [], origin: 'suggestion' }]);
  expect(after.edited_refs).toEqual(['l-3', 'l-10', 'l-9', 'l-11']);
  expect(t.versions()).toEqual([1, 2]);
  const event = JSON.parse(t.db.prepare("SELECT detail FROM application_events WHERE kind = 'edited'").pluck().get() as string);
  expect(event).toMatchObject({ lines: 4, version: 2, refs: ['l-3', 'l-10', 'l-9', 'l-11'] });
  expect(event.edit_distance).toBeGreaterThan(0); // two model lines changed, two (l-1, l-8) removed and counted as 1
  expect(event.edit_distance).toBeLessThanOrEqual(1);
  const audits = t.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'career.application.edit'").pluck().all() as string[];
  expect(audits.map((a) => Object.keys(JSON.parse(a)).sort())).toEqual([['edit_distance', 'id', 'lines', 'version']]);

  // Stale versions: nothing written.
  expect((await t.put({ versions: 1, cv: { sections: [] }, letter: { paragraphs: [] } })).json()).toEqual({ error: 'draft_changed' });
  // A removed id is never handed out again; an unchanged save bumps the version with no refs.
  const next = await t.put({ versions: 2, cv: after.draft.cv, letter: { paragraphs: [l7, { text: 'Canary-p4 new' }] } });
  expect((next.json() as { draft: Draft }).draft.letter.paragraphs.map((p) => p.id)).toEqual(['l-7', 'l-12']);
  const same = await t.put({ versions: 3, cv: after.draft.cv, letter: (next.json() as { draft: Draft }).draft.letter });
  expect([same.statusCode, (same.json() as { draft: Draft }).draft.versions]).toEqual([200, 4]);
  expect(JSON.parse(t.db.prepare("SELECT detail FROM application_events WHERE kind = 'edited' ORDER BY id DESC").pluck().get() as string)).toMatchObject({ lines: 0, refs: [], edit_distance: null });
  expect((await t.get(t.id)).edited_refs).toEqual(['l-3', 'l-10', 'l-9', 'l-11', 'l-12']);
  expect(t.everything()).not.toContain('Canary-');
});

test('PUT …/draft validates the whole document; one bad part writes nothing', async () => {
  const t = await drafted();
  const d = await t.draft();
  const north = section<EntrySection>(d, 'Experience').entries[0]!;
  const ok = { versions: 1, cv: d.cv, letter: d.letter };
  const withEntry = (e: object) => ({ ...ok, cv: { sections: [{ name: 'Experience', entries: [{ ...north, ...e }] }] } });
  const line = (text: string) => ({ ...ok, letter: { paragraphs: [{ text }] } });
  const many = (n: number, x: unknown) => Array.from({ length: n }, () => x);
  const bad = [
    { cv: d.cv, letter: d.letter },
    { ...ok, versions: 0 },
    { ...ok, cv: { sections: many(8, { name: 'Summary', bullets: [] }) } },
    { ...ok, cv: { sections: [{ name: 'Hobbies', bullets: [] }] } },
    { ...ok, cv: { sections: [{ name: 'Summary', entries: [] }] } },
    { ...ok, cv: { sections: [{ name: 'Experience', bullets: [] }] } },
    { ...ok, cv: { sections: [{ name: 'Summary', bullets: [], entries: [] }] } },
    { ...ok, cv: { sections: [{ name: 'Skills', bullets: [] }, { name: 'Skills', bullets: [] }] } },
    { ...ok, cv: { sections: [{ name: 'Experience', entries: many(31, { org: '', title: '', start: '', end: '', location: '', bullets: [] }) }] } },
    withEntry({ bullets: many(41, { text: 'x' }) }),
    withEntry({ org: 'A | B' }),
    withEntry({ title: 'x'.repeat(121) }),
    withEntry({ location: 'Ham\nburg' }),
    withEntry({ start: 'March 2020' }),
    withEntry({ end: 'now' }),
    withEntry({ start: '' }), // a master entry keeps a real start
    line(''),
    line('   '),
    line('x'.repeat(2001)),
    line('two\nlines'),
    { ...ok, letter: { paragraphs: many(13, { text: 'x' }) } },
    { ...ok, letter: { paragraphs: [d.letter.paragraphs[0], d.letter.paragraphs[0]] } }, // an id twice
  ];
  for (const body of bad) expect([JSON.stringify(body).slice(0, 80), (await t.put(body)).json()]).toEqual([JSON.stringify(body).slice(0, 80), { error: 'bad_draft' }]);
  expect(t.versions()).toEqual([1]);
  // An owner entry may leave its dates empty; a header field may be 120 characters.
  const own = { ...ok, cv: { sections: [{ name: 'Projects', entries: [{ org: 'x'.repeat(120), title: '', start: '', end: '', location: '', bullets: [] }] }] } };
  expect((await t.put(own)).statusCode).toBe(200);
  expect((await t.put(ok, 999)).json()).toEqual({ error: 'not_found' });
});

test.each(['processing', 'failed', 'final', 'applied', 'withdrawn'])('PUT …/draft on a %s application is wrong_status', async (status) => {
  const t = await drafted(status);
  const d = await t.draft();
  const res = await t.put({ versions: 1, cv: d.cv, letter: d.letter });
  expect([res.statusCode, res.json()]).toEqual([409, { error: 'wrong_status' }]);
});

test('a flagged draft can be edited', async () => {
  const t = await drafted('flagged');
  const d = await t.draft();
  const skills = section<BulletSection>(d, 'Skills');
  expect((await t.put({ versions: 1, cv: { sections: [{ ...skills, bullets: [...skills.bullets, { text: 'Rust' }] }] }, letter: d.letter })).statusCode).toBe(200);
});

// ---------- admin: rename, retry, archive, delete ----------

type T = Awaited<ReturnType<typeof setup>>;
const call = (t: T, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
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
    ['PUT', `/${id}/draft`, { versions: 1, cv: { sections: [] }, letter: { paragraphs: [] } }], ['POST', `/${id}/final`], ['POST', `/${id}/render`], ['GET', `/${id}/files/cv_docx`],
    ['GET', `/${id}/milestones`], ['POST', `/${id}/milestones`, { kind: 'note', on_date: '2026-10-01' }],
  ];
  for (const [method, url, body] of routes) expect([method, url, (await call(t, method, url, body)).statusCode]).toEqual([method, url, 404]);
  expect(JSON.parse(t.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'career.application.delete'").pluck().get() as string)).toEqual({ id, texts: 1, milestones: 1, files: 1 });
  expect(t.dump() + JSON.stringify(eventsOf(t, id))).not.toContain('Canary-d');
});
