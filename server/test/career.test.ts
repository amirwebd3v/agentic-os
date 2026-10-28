import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
