import { readdirSync } from 'node:fs';
import { expect, test } from 'vitest';
import { loggerOptions } from '../src/app.ts';
import { migrate } from '../src/db/migrate.ts';
import { careerRoutes } from '../src/http/routes/career.ts';
import { buildTestApp, makeTestDb } from './helpers.ts';

const NOTE = 'Canary-9d1e recruiter Jane said <b>no</b>';
const LATEST = Math.max(...readdirSync(new URL('../migrations/', import.meta.url)).map((n) => Number(n.slice(0, 4))));
type Detail = { status: string; follow_up_on: string | null; milestones: { id: number; kind: string; on_date: string; note: string | null }[] };

async function setup() {
  const logs: string[] = [];
  const t = await buildTestApp({
    loggedIn: true,
    plugins: [careerRoutes({ vaultDir: '/nonexistent' })],
    logger: { ...loggerOptions, level: 'info', stream: { write: (s: string) => logs.push(s) } },
  });
  const app = (status = 'final', step: string | null = null) =>
    Number(t.db.prepare("INSERT INTO applications (status, step, master_hash) VALUES (?, ?, 'h')").run(status, step).lastInsertRowid);
  const req = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
    const r = await t.app.inject(t.authed({ method, url: `/api/career/applications${url}`, ...(payload && { payload }) }));
    return { code: r.statusCode, body: r.json() as Detail & { error?: string; id: number } };
  };
  const dump = () =>
    JSON.stringify(t.db.prepare('SELECT * FROM application_events').all()) + JSON.stringify(t.db.prepare('SELECT * FROM audit_log').all()) + logs.join('');
  return { ...t, app, req, dump, logs };
}

test('0007 applies on a database at version 6 and keeps its applications', () => {
  const db = makeTestDb();
  db.prepare("INSERT INTO applications (status, master_hash) VALUES ('final', 'h')").run();
  db.exec('DROP TABLE application_milestones; ALTER TABLE applications DROP COLUMN archived_at; ALTER TABLE applications DROP COLUMN deleted_at');
  db.pragma('user_version = 6'); // 0007 and 0008 apply again
  migrate(db);
  expect(db.pragma('user_version', { simple: true })).toBe(LATEST);
  expect(db.prepare('SELECT status FROM applications').pluck().all()).toEqual(['final']);
  expect(db.prepare('SELECT count(*) FROM application_milestones').pluck().get()).toBe(0);
});

test('milestone CHECKs: kind, a real date, a note of at most 2000 chars', () => {
  const db = makeTestDb();
  db.prepare("INSERT INTO applications (status, master_hash) VALUES ('final', 'h')").run();
  const add = (kind: string, on: string, note: string | null = null) =>
    db.prepare('INSERT INTO application_milestones (application_id, kind, on_date, note) VALUES (1, ?, ?, ?)').run(kind, on, note);
  expect(() => add('ghosted', '2026-10-01')).toThrow(/CHECK/);
  for (const bad of ['soon', '2026-13-01', '2026-02-30', '2026-10-01 10:00']) expect(() => add('note', bad)).toThrow(/CHECK/);
  expect(() => add('note', '2026-10-01', 'x'.repeat(2001))).toThrow(/CHECK/);
  expect(() => add('interview', '2099-01-05', 'x'.repeat(2000))).not.toThrow();
});

test('milestone CRUD validates, syncs the status both ways, and keeps the note out of events, audit and logs', async () => {
  const t = await setup();
  const id = t.app();
  expect(await t.req('GET', `/${id}/milestones`)).toEqual({ code: 200, body: [] });
  expect((await t.req('GET', '/999/milestones')).code).toBe(404);
  expect((await t.req('GET', `/${id}`)).body.milestones).toEqual([]);

  for (const bad of [{}, { kind: 'ghosted', on_date: '2026-10-01' }, { kind: 'note' }, { kind: 'note', on_date: '2026-10-01', note: 'x'.repeat(2001) }])
    expect((await t.req('POST', `/${id}/milestones`, bad)).code).toBe(400);
  expect(await t.req('POST', `/${id}/milestones`, { kind: 'note', on_date: '2026-02-30' })).toEqual({ code: 400, body: { error: 'bad_date' } });
  expect((await t.req('POST', '/999/milestones', { kind: 'note', on_date: '2026-10-01' })).code).toBe(404);

  const applied = await t.req('POST', `/${id}/milestones`, { kind: 'applied', on_date: '2026-10-01', note: `  ${NOTE}  ` });
  expect(applied.code).toBe(201);
  expect(applied.body.status).toBe('applied');
  expect(applied.body.milestones).toMatchObject([{ kind: 'applied', on_date: '2026-10-01', note: NOTE }]);
  const appliedId = applied.body.milestones[0]!.id;

  // An upcoming interview, entered before the earlier feedback: the timeline is by date.
  await t.req('POST', `/${id}/milestones`, { kind: 'interview', on_date: '2099-01-05', note: NOTE });
  const fb = await t.req('POST', `/${id}/milestones`, { kind: 'feedback', on_date: '2026-10-10' });
  expect(fb.body.milestones.map((m) => m.kind)).toEqual(['applied', 'feedback', 'interview']);
  const fbId = fb.body.milestones[1]!.id;

  expect((await t.req('PATCH', `/${id}/milestones/${fbId}`, {})).code).toBe(400);
  expect(await t.req('PATCH', `/${id}/milestones/${fbId}`, { on_date: '10/12/2026' })).toEqual({ code: 400, body: { error: 'bad_date' } });
  expect((await t.req('PATCH', `/${id}/milestones/999`, { note: 'x' })).code).toBe(404);
  const other = t.app();
  expect((await t.req('PATCH', `/${other}/milestones/${fbId}`, { note: 'x' })).code).toBe(404);
  expect((await t.req('DELETE', `/${other}/milestones/${fbId}`)).code).toBe(404);
  const edited = await t.req('PATCH', `/${id}/milestones/${fbId}`, { on_date: '2026-10-11', note: NOTE });
  expect(edited.body.milestones[1]).toMatchObject({ kind: 'feedback', on_date: '2026-10-11', note: NOTE });
  expect((await t.req('PATCH', `/${id}/milestones/${fbId}`, { note: null })).body.milestones[1]!.note).toBeNull();

  // withdrawn wins while it is the latest applied/withdrawn milestone; deleting it reverts.
  const w = await t.req('POST', `/${id}/milestones`, { kind: 'withdrawn', on_date: '2026-10-20' });
  expect(w.body.status).toBe('withdrawn');
  const wId = w.body.milestones.find((m) => m.kind === 'withdrawn')!.id;
  expect((await t.req('PATCH', `/${id}/milestones/${wId}`, { on_date: '2026-09-01' })).body.status).toBe('applied'); // now before the application
  expect((await t.req('DELETE', `/${id}/milestones/${wId}`)).body.status).toBe('applied');
  const reverted = await t.req('DELETE', `/${id}/milestones/${appliedId}`);
  expect(reverted.body.status).toBe('final');
  expect((await t.req('DELETE', `/${id}/milestones/${appliedId}`)).code).toBe(404);

  const events = t.db.prepare("SELECT detail FROM application_events WHERE application_id = ? AND kind = 'status' ORDER BY id").pluck().all(id) as string[];
  expect(JSON.parse(events[0]!)).toEqual({ op: 'add', milestone: appliedId, kind: 'applied', on_date: '2026-10-01', from: 'final', to: 'applied' });
  expect(JSON.parse(events.at(-1)!)).toEqual({ op: 'delete', milestone: appliedId, kind: 'applied', on_date: '2026-10-01', from: 'applied', to: 'final' });
  expect(t.db.prepare("SELECT count(*) FROM audit_log WHERE action = 'career.application.track'").pluck().get()).toBe(events.length);
  expect(t.logs.length).toBeGreaterThan(0); // the capture works
  expect(t.dump()).not.toContain('Canary-9d1e');
});

test('milestone writes wait for the pipeline: wrong_status before final and while rendering', async () => {
  const t = await setup();
  for (const [status, step] of [['processing', 'draft'], ['draft_ready', null], ['flagged', null], ['failed', null], ['final', 'render']] as const) {
    const id = t.app(status, step);
    expect(await t.req('POST', `/${id}/milestones`, { kind: 'applied', on_date: '2026-10-01' })).toEqual({ code: 409, body: { error: 'wrong_status' } });
  }
});

test('the list shows the latest milestone, the next interview and the follow-up date', async () => {
  const t = await setup();
  const id = t.app();
  await t.req('POST', `/${id}/milestones`, { kind: 'interview', on_date: '2000-01-01' }); // past: not "next"
  await t.req('POST', `/${id}/milestones`, { kind: 'interview', on_date: '2099-02-01' });
  await t.req('POST', `/${id}/milestones`, { kind: 'interview', on_date: '2099-01-05' });
  expect(await t.req('PATCH', `/${id}`, { follow_up_on: '2026-02-30' })).toEqual({ code: 400, body: { error: 'bad_date' } });
  expect((await t.req('PATCH', `/${id}`, {})).code).toBe(400);
  expect((await t.req('PATCH', '/999', { follow_up_on: null })).code).toBe(404);
  expect((await t.req('PATCH', `/${id}`, { follow_up_on: '2026-11-03' })).body.follow_up_on).toBe('2026-11-03');
  const list = (await t.req('GET', '')).body as unknown as Record<string, unknown>[];
  expect(list[0]).toMatchObject({ id, follow_up_on: '2026-11-03', last_milestone: 'interview', last_milestone_on: '2099-02-01', next_interview: '2099-01-05' });
  expect((await t.req('PATCH', `/${id}`, { follow_up_on: null })).body.follow_up_on).toBeNull();
});

test('an application sent elsewhere: applied with its milestone, and stays applied without it', async () => {
  const t = await setup();
  for (const bad of [{ company: ' ', role_title: 'Dev', applied_on: '2026-10-01' }, { company: 'Acme', applied_on: '2026-10-01' }])
    expect((await t.req('POST', '/manual', bad)).code).toBe(400);
  expect(await t.req('POST', '/manual', { company: 'Acme', role_title: 'Dev', applied_on: 'yesterday' })).toEqual({ code: 400, body: { error: 'bad_date' } });

  const res = await t.req('POST', '/manual', { company: ' Canary-9d1e Acme ', role_title: 'Dev', applied_on: '2026-10-01' });
  expect(res.code).toBe(201);
  expect(res.body).toMatchObject({ company: 'Canary-9d1e Acme', role_title: 'Dev', status: 'applied', step: null });
  const detail = await t.req('GET', `/${res.body.id}`);
  expect(detail.body).toMatchObject({ status: 'applied', milestones: [{ kind: 'applied', on_date: '2026-10-01', note: null }] });
  expect((await t.req('POST', `/${res.body.id}/milestones`, { kind: 'rejected', on_date: '2026-10-15' })).body.status).toBe('applied');
  const removed = await t.req('DELETE', `/${res.body.id}/milestones/${detail.body.milestones[0]!.id}`);
  expect(removed.body.status).toBe('applied'); // no draft to fall back to
  expect(t.dump()).not.toContain('Canary-9d1e');
});
