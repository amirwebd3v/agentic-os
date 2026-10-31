import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { refreshDraft } from '../src/career/draft.ts';
import type { CvEntry, Draft } from '../src/career/draft.ts';
import { parseConfig } from '../src/config.ts';
import { careerRoutes, failCareerJob } from '../src/http/routes/career.ts';
import { careerDraft } from '../src/jobs/career-draft.ts';
import { careerIntake } from '../src/jobs/career-intake.ts';
import { careerMatch } from '../src/jobs/career-match.ts';
import { careerAts, careerCompany, careerGaps, careerLetter, careerLetterVerify, careerQuestions, careerVacancy } from '../src/jobs/career-steps.ts';
import { careerVerify } from '../src/jobs/career-verify.ts';
import { runNext } from '../src/jobs/runner.ts';
import { LlmError } from '../src/llm/errors.ts';
import { buildTestApp, capturePrompts } from './helpers.ts';

// #72 (edit the posting, stale parts) and #73 (refresh the posting, the CV, the letter) through the routes and the
// real runner, with a fake model.

const FIXTURES = join(import.meta.dirname, 'fixtures', 'career');
const N = 'exp-northwind-logistics-2021';
const K = 'exp-kestrel-data-2018';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const POSTING = 'Platform Engineer - Marlowe Freight Technologies\nRequirements: Terraform and AWS (ECS, RDS, IAM).\nSenior level.';
const POSTING_2 = `${POSTING}\nAlso: Canary-p2 Kubernetes.`;
const INTAKE = {
  language: 'en', company: 'Marlowe Freight Technologies', role_title: 'Platform Engineer', seniority: 'senior', location_mode: 'hybrid',
  must_have: [{ text: 'Terraform and AWS', kind: 'skill' }], nice_to_have: [], injection_suspected: false,
};
const SELECTION = { picks: [{ requirement_id: 'must-1', bullet_ids: [`${N}-4d5e6f`] }], entries: [{ entry_id: N, bullet_ids: [`${N}-1a2b3c`] }], skill_ids: ['skill-aws'] };
const NW = { entry_id: N, bullets: [{ text: 'Cut deploy time from 40 to 9 minutes by moving CI to GitHub Actions.', cites: [`${N}-1a2b3c`] }] };
const KD = { entry_id: K, bullets: [{ text: 'Ran 120 Linux servers with a 99.9% uptime target.', cites: [`${K}-0a1b2c`] }] };
const SUMMARY = { text: 'Platform engineer with 6 years in DevOps and cloud infrastructure.', cites: ['sum-1'] };
const DRAFT_1 = { summary: SUMMARY, entries: [NW, KD], skill_ids: ['skill-aws'] };
const DRAFT_2 = { summary: SUMMARY, entries: [NW], skill_ids: ['skill-aws'] }; // the refresh drops Kestrel
const GAPS = { missing_keywords: [], weak_sections: [], formatting: [], suggestions: [] };
const crit = { score: 5, cv_quote: 'Cut deploy time', posting_quote: 'Terraform and AWS', note: 'Fits.' };
const RUBRIC = { relevance: crit, seniority: crit, skills: crit, clarity: crit, findings: [] };
const COMPANY = { points: [] };
const VACANCY = { why_open: { text: 'x', quotes: [] }, business_problem: { text: 'x', quotes: [] }, outcomes: [], priorities: [] };
const ONE_QUESTION = { evidence: [], questions: [{ text: 'Have you run Kubernetes?', why: 'Required.' }] };
const LETTER = { paragraphs: [{ text: 'I cut deploy time from 40 to 9 minutes by moving CI to GitHub Actions.', cites: [`${N}-1a2b3c`] }] };

async function setup(over: Record<string, () => unknown> = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'aos-refresh-'));
  dirs.push(vault);
  mkdirSync(join(vault, 'career'));
  for (const f of ['master.md', 'contact.md']) copyFileSync(join(FIXTURES, f), join(vault, 'career', f));
  const drafts = [DRAFT_1, DRAFT_2, DRAFT_2];
  const by: Record<string, () => unknown> = {
    'career-intake': () => INTAKE, 'career-match': () => SELECTION, 'career-gaps': () => GAPS, 'career-draft': () => drafts.shift() ?? DRAFT_2,
    'career-ats': () => RUBRIC, 'career-company': () => COMPANY, 'career-vacancy': () => VACANCY, 'career-questions': () => ({ evidence: [], questions: [] }),
    'career-letter': () => LETTER, ...over,
  };
  const cap = capturePrompts((req) => by[req.pipeline]!());
  const t = await buildTestApp({ loggedIn: true, plugins: [careerRoutes({ vaultDir: vault, dataDir: vault, llm: cap.llm })] });
  const deps = { db: t.db, config: parseConfig({ vaultDir: vault, dataDir: vault }), llm: cap.llm };
  const handlers = {
    career_intake: careerIntake(deps), career_match: careerMatch(deps), career_gaps: careerGaps(deps), career_draft: careerDraft(deps), career_verify: careerVerify(deps),
    career_ats: careerAts(deps), career_company: careerCompany(deps), career_vacancy: careerVacancy(deps), career_questions: careerQuestions(deps),
    career_letter: careerLetter(deps), career_letter_verify: careerLetterVerify(deps),
  };
  const drain = async () => {
    for (;;) {
      try {
        if (!(await runNext(t.db, handlers, (job) => failCareerJob(t.db, job)))) return;
      } catch {
        // the runner already marked the job and the application
      }
    }
  };
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    t.app.inject(t.authed({ method, url: `/api/career/applications${url}`, ...(payload && { payload }) }));
  type Detail = Record<string, unknown> & { status: string; draft: Draft; stale: { cv: string | null; letter: string | null } | null; can_restore: boolean };
  const detail = async (id: number) => (await call('GET', `/${id}`)).json() as Detail;
  const steps = () => cap.calls.map((c) => c.pipeline.replace('career-', ''));
  /** Creates an application and runs it to rest. */
  const created = async (body: object = { posting: POSTING }) => {
    const { id } = (await call('POST', '', body)).json() as { id: number };
    await drain();
    return id;
  };
  const logs = () =>
    JSON.stringify([
      t.db.prepare('SELECT kind, payload, error FROM jobs').all(),
      t.db.prepare('SELECT action, args_redacted FROM audit_log').all(),
      t.db.prepare('SELECT kind, detail FROM application_events').all(),
    ]);
  return { ...t, cap, vault, drain, call, detail, steps, created, logs };
}

const entries = (d: Draft) => d.cv.sections.flatMap((s) => ('entries' in s ? s.entries : []));

test('editing the posting: same limits as create; unchanged is a no-op; a new text re-reads only intake → match → gaps and comes back to rest', async () => {
  const t = await setup();
  const id = await t.created();
  const before = await t.detail(id);
  expect(before).toMatchObject({ status: 'flagged', posting: POSTING, stale: { cv: null, letter: null }, can_restore: false });
  const calls = t.cap.calls.length;

  for (const [body, error] of [
    [{ posting: 'x'.repeat(30_001) }, 'posting_too_long'],
    [{ posting: POSTING, research: 'x'.repeat(20_001) }, 'research_too_long'],
  ] as const) {
    expect((await t.call('PUT', `/${id}/posting`, body)).json()).toEqual({ error });
  }
  expect((await t.call('PUT', `/${id}/posting`, { posting: POSTING, company_name: 'x'.repeat(201) })).statusCode).toBe(400);

  // Unchanged: nothing stored, nothing run.
  const same = await t.call('PUT', `/${id}/posting`, { posting: POSTING });
  expect(same.statusCode).toBe(200);
  expect(t.db.prepare("SELECT count(*) FROM application_texts WHERE kind = 'posting'").pluck().get()).toBe(1);
  expect(t.db.prepare("SELECT count(*) FROM jobs WHERE status = 'queued'").pluck().get()).toBe(0);

  const jobs = t.db.prepare("SELECT max(id) FROM jobs").pluck().get() as number;
  const res = await t.call('PUT', `/${id}/posting`, { posting: POSTING_2, company_name: 'Canary-c9 Co' });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toMatchObject({ status: 'processing', step: 'intake', posting: POSTING_2 });
  // Busy while it runs.
  expect((await t.call('PUT', `/${id}/posting`, { posting: POSTING })).json()).toEqual({ error: 'busy' });
  expect((await t.call('POST', `/${id}/refresh`, { part: 'cv' })).json()).toEqual({ error: 'busy' });
  await t.drain();
  expect(t.steps().slice(calls)).toEqual(['intake', 'match', 'gaps']);
  const after = await t.detail(id);
  expect(after).toMatchObject({ status: before.status, step: before.step, fail_code: before.fail_code, posting: POSTING_2 });
  expect(after.context).toMatchObject({ company_name: 'Canary-c9 Co' });
  expect(after.draft).toEqual(before.draft); // the CV and letter are not redrafted…
  expect(after.stale).toEqual({ cv: 'posting', letter: 'posting' }); // …they are out of date
  // The second run's keys take the next run number.
  expect(t.db.prepare("SELECT idempotency_key FROM jobs WHERE id > ? ORDER BY id").pluck().all(jobs)).toEqual([
    `career:intake:${id}:1`, `career:match:${id}:0:1`, `career:gaps:${id}:0:1`,
  ]);
  expect(t.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'career.application.posting_edit'").pluck().all().map((a) => JSON.parse(a as string))).toEqual([
    { id, chars: POSTING_2.length, research_chars: 0, fields: ['company_name'], rerun: true },
  ]);
  expect(t.logs()).not.toMatch(/Canary/);
});

test('Refresh CV: match → … → ats with the current posting; owner lines carried over; letter kept; Restore puts the old CV back', async () => {
  const t = await setup();
  const id = await t.created();
  const d0 = (await t.detail(id)).draft;
  // The owner adds a line under Northwind, one under Kestrel and an entry of their own.
  const put = structuredClone(d0) as Draft;
  const [nw, kd] = entries(put) as [CvEntry, CvEntry];
  nw.bullets.push({ id: 'new-1', text: 'Mentored two juniors.', cites: [], origin: 'owner' });
  kd.bullets.push({ id: 'new-2', text: 'Ran the backups.', cites: [], origin: 'owner' });
  (put.cv.sections.find((s) => s.name === 'Experience') as { entries: CvEntry[] }).entries.push({
    id: 'new-e', org: 'Side Co', title: 'Volunteer', start: '', end: '', location: '', bullets: [{ id: 'new-3', text: 'Taught kids to code.', cites: [], origin: 'owner' }],
  });
  const saved = await t.call('PUT', `/${id}/draft`, put);
  expect(saved.statusCode).toBe(200);
  const d1 = (saved.json() as { draft: Draft }).draft;
  await t.call('PUT', `/${id}/posting`, { posting: POSTING_2 });
  await t.drain();
  const calls = t.cap.calls.length;

  expect((await t.call('POST', `/${id}/refresh`, { part: 'cv' })).statusCode).toBe(202);
  await t.drain();
  expect(t.steps().slice(calls)).toEqual(['match', 'gaps', 'draft', 'ats']);
  const after = await t.detail(id);
  // The kept letter was flagged (too short) before the refresh; the new CV passing doesn't clear that.
  expect(after).toMatchObject({ status: 'flagged', fail_code: 'verify_failed' });
  const report = t.db.prepare("SELECT body FROM application_texts WHERE kind = 'verify_report' ORDER BY version DESC LIMIT 1").pluck().get() as string;
  expect(report).toContain('letter_length');
  expect(after.stale).toEqual({ cv: null, letter: 'posting' }); // the letter still rests on the old posting
  expect(after.can_restore).toBe(true);
  const d2 = after.draft;
  expect(d2.letter).toEqual(d1.letter);
  expect(d2.versions).toBe(d1.versions + 1);
  const exp = entries(d2);
  expect(exp.map((e) => e.org)).toEqual(['Northwind Logistics', 'Kestrel Data', 'Side Co']); // Kestrel is gone from the new CV: its owner line goes last, with its entry
  expect(exp[0]!.bullets.map((b) => [b.text, b.origin])).toEqual([
    ['Cut deploy time from 40 to 9 minutes by moving CI to GitHub Actions.', 'model'],
    ['Mentored two juniors.', 'owner'],
  ]);
  expect(exp[1]!.bullets.map((b) => b.text)).toEqual(['Ran the backups.']);
  const ids = [...JSON.stringify(d2).matchAll(/"id":"(l-\d+)"/g)].map((m) => m[1]);
  expect(new Set(ids).size).toBe(ids.length); // no id repeats

  // Restore: refused on a stale version, then the old CV comes back as a new version, letter untouched.
  expect((await t.call('POST', `/${id}/draft/restore`, { versions: d1.versions })).json()).toEqual({ error: 'draft_changed' });
  const back = await t.call('POST', `/${id}/draft/restore`, { versions: d2.versions });
  expect(back.statusCode).toBe(200);
  const d3 = (back.json() as { draft: Draft; stale: unknown; can_restore: boolean });
  expect(d3.draft.cv).toEqual(d1.cv);
  expect(d3.draft.versions).toBe(d2.versions + 1);
  expect(d3.stale).toEqual({ cv: 'posting', letter: 'posting' });
  expect(d3.can_restore).toBe(false);
  expect(t.db.prepare("SELECT action FROM audit_log WHERE action IN ('career.application.refresh', 'career.application.restore')").pluck().all()).toEqual([
    'career.application.refresh', 'career.application.restore',
  ]);
  expect(t.logs()).not.toMatch(/Mentored|backups|Canary/);
});

test('the master changed: the CV says so; a missing master refuses a refresh with master_missing', async () => {
  const t = await setup();
  const id = await t.created();
  appendFileSync(join(t.vault, 'career', 'master.md'), '\n');
  expect((await t.detail(id)).stale).toEqual({ cv: 'master', letter: null });
  rmSync(join(t.vault, 'career', 'master.md'));
  expect((await t.call('POST', `/${id}/refresh`, { part: 'cv' })).json()).toEqual({ error: 'master_missing' });
});

test('needs_answers: a CV refresh keeps the pending questions; a letter refresh asks them again', async () => {
  const t = await setup({ 'career-questions': () => ONE_QUESTION });
  const id = await t.created();
  const q = await t.detail(id);
  expect(q.status).toBe('needs_answers');
  await t.call('POST', `/${id}/refresh`, { part: 'cv' });
  await t.drain();
  expect(await t.detail(id)).toMatchObject({ status: 'needs_answers', step: 'questions', questions: q.questions });
  expect(t.db.prepare("SELECT count(*) FROM application_texts WHERE kind = 'questions'").pluck().get()).toBe(1);

  await t.call('POST', `/${id}/answers`, { answers: [{ id: 'q-1', text: 'Yes, for 4 teams.' }] });
  await t.drain();
  expect((await t.detail(id)).answers).not.toBeNull();
  const calls = t.cap.calls.length;
  expect((await t.call('POST', `/${id}/refresh`, { part: 'letter' })).statusCode).toBe(202);
  await t.drain();
  expect(t.steps().slice(calls)).toEqual(['company', 'vacancy', 'questions']);
  expect(await t.detail(id)).toMatchObject({ status: 'needs_answers', answers: null }); // the old answers no longer count
});

test('final: a refresh brings the application back to a draft and keeps the old files; archived is refused', async () => {
  const t = await setup();
  const id = await t.created();
  t.db.prepare("UPDATE applications SET status = 'final', step = NULL WHERE id = ?").run(id);
  t.db.prepare("INSERT INTO application_files (application_id, kind, relpath, bytes, sha256) VALUES (?, 'cv_docx', 'x/cv.docx', 10, 'h')").run(id);
  await t.call('POST', `/${id}/refresh`, { part: 'posting' });
  await t.drain();
  expect(await t.detail(id)).toMatchObject({ status: 'flagged', files: [{ kind: 'cv_docx', bytes: 10 }] });
  expect((await t.call('POST', `/${id}/render`)).json()).toEqual({ error: 'wrong_status' }); // render needs finalising again

  await t.call('POST', `/${id}/archive`, { archived: true });
  expect((await t.call('POST', `/${id}/refresh`, { part: 'cv' })).json()).toEqual({ error: 'archived' });
  expect((await t.call('PUT', `/${id}/posting`, { posting: POSTING_2 })).json()).toEqual({ error: 'archived' });
});

test('failed: a CV refresh is a retry from match and runs to the end', async () => {
  let fail = true;
  const t = await setup({
    'career-company': () => {
      if (fail) throw new LlmError('overloaded', 'provider error 529', 529);
      return COMPANY;
    },
  });
  const id = await t.created();
  expect(await t.detail(id)).toMatchObject({ status: 'failed', step: 'company' });
  fail = false;
  const calls = t.cap.calls.length;
  await t.call('POST', `/${id}/refresh`, { part: 'cv' });
  await t.drain();
  expect(t.steps().slice(calls, calls + 8)).toEqual(['match', 'gaps', 'draft', 'ats', 'company', 'vacancy', 'questions', 'letter']);
  expect((await t.detail(id)).status).not.toBe('failed');
});

test('refreshDraft: an owner line whose entry has no source, or whose section is gone, still finds a place', () => {
  const line = (id: string, origin: 'model' | 'owner' | 'suggestion') => ({ id, text: id, cites: [], origin });
  const prev: Draft = {
    v: 2,
    cv: { sections: [{ name: 'Skills', bullets: [line('l-1', 'model'), line('l-2', 'suggestion')] }] },
    letter: { paragraphs: [line('l-3', 'model')] },
    versions: 4,
  };
  const fresh: Draft = { v: 2, cv: { sections: [{ name: 'Summary', bullets: [line('l-1', 'model')] }] }, letter: { paragraphs: [] }, versions: 1 };
  expect(refreshDraft(prev, fresh, { l: 3, e: 0 })).toEqual({
    v: 2,
    cv: { sections: [{ name: 'Summary', bullets: [line('l-4', 'model')].map((l) => ({ ...l, text: 'l-1' })) }, { name: 'Skills', bullets: [line('l-2', 'suggestion')] }] },
    letter: prev.letter,
    versions: 5,
  });
});
