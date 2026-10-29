import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { atsCode, verbatim } from '../src/career/ats.ts';
import type { Draft } from '../src/career/draft.ts';
import { hasWord, masterText } from '../src/career/gaps.ts';
import { readMaster } from '../src/career/tailor.ts';
import { parseConfig } from '../src/config.ts';
import { careerRoutes, failCareerJob, MAX_RESEARCH_CHARS, retryRun } from '../src/http/routes/career.ts';
import { careerDraft } from '../src/jobs/career-draft.ts';
import { careerIntake } from '../src/jobs/career-intake.ts';
import { careerMatch } from '../src/jobs/career-match.ts';
import { careerAts, careerCompany, careerGaps, careerLetter, careerLetterVerify, careerQuestions, careerVacancy } from '../src/jobs/career-steps.ts';
import { careerVerify } from '../src/jobs/career-verify.ts';
import { runNext } from '../src/jobs/runner.ts';
import { LlmError } from '../src/llm/errors.ts';
import { buildTestApp, capturePrompts } from './helpers.ts';

// career-v2.md §3–§5 through the routes and the real runner, with a fake model.

const FIXTURES = join(import.meta.dirname, 'fixtures', 'career');
const N = 'exp-northwind-logistics-2021';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const POSTING = 'Platform Engineer - Marlowe Freight Technologies\nRequirements: Terraform and AWS (ECS, RDS, IAM). Work with product teams to improve deploy times.\nSenior level.';
const RESEARCH = 'Canary-r7 notes: Marlowe raised a Series B in 2025.\nReferrals: jane.doe@example.com';
const ANSWER = 'I moved 4 teams to Kubernetes.';

const INTAKE = {
  language: 'en', company: 'Marlowe Freight Technologies', role_title: 'Platform Engineer', seniority: 'senior', location_mode: 'hybrid',
  must_have: [{ text: 'Terraform and AWS', kind: 'skill' }, { text: 'Kubernetes operations', kind: 'skill' }], nice_to_have: [], injection_suspected: false,
};
const SELECTION = { picks: [{ requirement_id: 'must-1', bullet_ids: [`${N}-4d5e6f`] }], entries: [{ entry_id: N, bullet_ids: [`${N}-1a2b3c`] }], skill_ids: ['skill-aws'] };
const DRAFT = {
  summary: { text: 'Platform engineer with 6 years in DevOps and cloud infrastructure.', cites: ['sum-1'] },
  entries: [{ entry_id: N, bullets: [{ text: 'Cut deploy time from 40 to 9 minutes by moving CI to GitHub Actions.', cites: [`${N}-1a2b3c`] }] }],
  skill_ids: ['skill-aws'],
};
const GAPS = {
  missing_keywords: [{ keyword: 'Kubernetes', importance: 'must' }],
  weak_sections: [],
  formatting: [{ problem: 'Only one bullet.' }],
  suggestions: [
    { section: 'Experience', entry_id: N, text: 'Ran Kubernetes for [number] teams.', why: 'Kubernetes is required.', keyword: 'Kubernetes' },
    { section: 'Skills', entry_id: null, text: 'Kubernetes', why: 'Kubernetes is required.', keyword: 'Kubernetes' },
  ],
};
const crit = (score: number) => ({ score, cv_quote: 'Cut deploy time from 40 to 9 minutes', posting_quote: 'improve deploy times', note: 'Fits.' });
const RUBRIC = { relevance: crit(8), seniority: crit(6), skills: crit(7), clarity: crit(9), findings: [] };
const COMPANY = {
  points: [
    { text: 'Raised a Series B.', quote: 'Marlowe raised a Series B in 2025.' },
    { text: 'Takes referrals.', quote: 'Referrals: jane.doe@example.com' }, // the model saw the placeholder, so this is not verbatim
  ],
};
const VACANCY = {
  why_open: { text: 'Deploys are slow.', quotes: ['improve deploy times'] },
  business_problem: { text: 'Deploys are slow.', quotes: ['improve deploy times'] },
  outcomes: [{ text: 'Faster deploys.', quotes: [] }],
  priorities: [],
};
const QUESTIONS = { evidence: [{ need: 'Kubernetes', master_ids: [] }], questions: [{ text: 'Have you run Kubernetes?', why: 'Required.' }, { text: 'Why Marlowe?', why: 'Motivation.' }] };
/** 267 words; the last paragraph rests on answer a-1. */
const LETTER = {
  paragraphs: [
    { text: `I am applying for the Platform Engineer role at Marlowe Freight Technologies.${' My work covers 6 years in DevOps and cloud infrastructure.'.repeat(9)}`, cites: ['sum-1'] },
    { text: 'I cut deploy time from 40 to 9 minutes by moving CI to GitHub Actions. '.repeat(7).trim(), cites: [`${N}-1a2b3c`] },
    { text: `${ANSWER} `.repeat(10).trim(), cites: ['a-1'] },
  ],
};

async function setup(answers: Record<string, () => unknown> = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'aos-letter-'));
  dirs.push(vault);
  mkdirSync(join(vault, 'career'));
  for (const f of ['master.md', 'contact.md']) copyFileSync(join(FIXTURES, f), join(vault, 'career', f));
  const by: Record<string, () => unknown> = {
    'career-intake': () => INTAKE, 'career-match': () => SELECTION, 'career-gaps': () => GAPS, 'career-draft': () => DRAFT, 'career-ats': () => RUBRIC,
    'career-company': () => COMPANY, 'career-vacancy': () => VACANCY, 'career-questions': () => QUESTIONS, 'career-letter': () => LETTER, ...answers,
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
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
    t.app.inject(t.authed({ method, url: `/api/career/applications${url}`, ...(payload && { payload }) }));
  const detail = async (id: number) => (await call('GET', `/${id}`)).json() as Record<string, unknown> & { draft: Draft };
  /** Every place that must hold ids, counts and codes only. */
  const logs = () =>
    JSON.stringify([
      t.db.prepare('SELECT kind, payload, error FROM jobs').all(),
      t.db.prepare('SELECT error FROM llm_calls').all(),
      t.db.prepare('SELECT action, args_redacted FROM audit_log').all(),
      t.db.prepare('SELECT kind, detail FROM application_events').all(),
    ]);
  return { ...t, cap, drain, call, detail, logs };
}

const FORM = { posting: POSTING, company_name: 'Canary-c1 Typed Co', company_website: 'https://marlowe.example', research: RESEARCH, target_country: 'Netherlands' };

test('create with the form fields: stored as one context row; the typed company shows until intake; counts only in the audit', async () => {
  const t = await setup();
  for (const [body, error] of [
    [{ ...FORM, research: 'x'.repeat(MAX_RESEARCH_CHARS + 1) }, 'research_too_long'],
    [{ ...FORM, company_name: 'x'.repeat(201) }, undefined],
    [{ ...FORM, company_website: 'x'.repeat(501) }, undefined],
    [{ ...FORM, target_country: 'x'.repeat(101) }, undefined],
  ] as const) {
    const res = await t.call('POST', '', body);
    expect(res.statusCode).toBe(400);
    if (error) expect(res.json()).toEqual({ error });
  }
  const res = await t.call('POST', '', { ...FORM, company_name: '  Canary-c1\tTyped Co ', research: `${RESEARCH}\r\n\u0007` });
  expect(res.statusCode).toBe(202);
  const { id, company } = res.json() as { id: number; company: string };
  expect(company).toBe('Canary-c1 Typed Co');
  expect((await t.detail(id)).context).toEqual({ company_name: 'Canary-c1 Typed Co', company_website: 'https://marlowe.example', target_country: 'Netherlands', research: RESEARCH });
  expect(JSON.parse(t.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'career.application.create'").pluck().get() as string)).toEqual({
    id, chars: POSTING.length, research_chars: RESEARCH.length, fields: ['company_name', 'company_website', 'target_country'],
  });
  // Without the extra fields: no context row.
  const plain = (await t.call('POST', '', { posting: POSTING })).json() as { id: number };
  expect((await t.detail(plain.id)).context).toBeNull();
});

test('the full agent: needs_answers, answers resume at the letter, the letter cites an answer and ends draft_ready; nothing personal in logs', async () => {
  const t = await setup();
  const { id } = (await t.call('POST', '', FORM)).json() as { id: number };
  expect((await t.call('POST', `/${id}/answers`, { answers: [] })).json()).toEqual({ error: 'wrong_status' });
  await t.drain();

  let d = await t.detail(id);
  expect(d).toMatchObject({ status: 'needs_answers', step: 'questions', company: 'Marlowe Freight Technologies', answers: null });
  expect(d.draft.letter.paragraphs).toEqual([]); // the letter is written after the answers
  expect(d.questions).toEqual({ evidence: [{ need: 'Kubernetes', master_ids: [] }], questions: [{ id: 'q-1', text: 'Have you run Kubernetes?', why: 'Required.' }, { id: 'q-2', text: 'Why Marlowe?', why: 'Motivation.' }] });
  expect(d.company_brief).toEqual({
    has_research: true,
    points: [
      { id: 'c-1', text: 'Raised a Series B.', status: 'verified', quotes: ['Marlowe raised a Series B in 2025.'] },
      { id: 'c-2', text: 'Takes referrals.', status: 'assumption', quotes: [] },
    ],
  });
  expect(d.vacancy).toMatchObject({ why_open: { status: 'verified' }, outcomes: [{ id: 'v-3', status: 'assumption' }] });
  expect(d.gaps).toMatchObject({ missing_keywords: [{ keyword: 'Kubernetes', importance: 'must', in_master: false }], suggestions: [{ id: 's-1', entry_id: N }, { id: 's-2' }], dismissed: [] });
  expect(d.ats).toMatchObject({ draft_version: 1, history: [{ draft_version: 1 }] });
  // The research is in the company prompt as data, with the contact value redacted.
  const company = t.cap.calls.find((c) => c.pipeline === 'career-company')!;
  expect(company.input).toMatch(/<research>\nCanary-r7 notes[\s\S]*\{\{CONTACT_EMAIL\}\}\n<\/research>/);
  expect(company.input).toContain('"company_website":"https://marlowe.example"');

  for (const bad of [{ answers: [{ id: 'q-9', text: 'x' }] }, { answers: [{ id: 'q-1', text: 'x' }, { id: 'q-1', text: 'y' }] }]) {
    expect((await t.call('POST', `/${id}/answers`, bad)).json()).toEqual({ error: 'bad_answers' });
  }
  expect((await t.call('POST', `/${id}/answers`, { answers: [{ id: 'q-1', text: 'x'.repeat(2001) }] })).statusCode).toBe(400);
  const res = await t.call('POST', `/${id}/answers`, { answers: [{ id: 'q-1', text: ` ${ANSWER}\u0000 ` }, { id: 'q-2', text: null }] });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toMatchObject({ status: 'processing', step: 'letter' });
  await t.drain();

  d = await t.detail(id);
  expect(d).toMatchObject({ status: 'draft_ready', step: 'letter_verify', fail_code: null, verify: { ok: true, violations: [] } });
  expect(d.answers).toEqual({ answers: [{ id: 'a-1', question_id: 'q-1', text: ANSWER }, { id: 'a-2', question_id: 'q-2', text: null }], questions_version: 1 });
  expect(d.draft.versions).toBe(2);
  expect(d.draft.letter.paragraphs.map((p) => [p.id, p.origin, p.cites])).toEqual([['l-6', 'model', ['sum-1']], ['l-7', 'model', [`${N}-1a2b3c`]], ['l-8', 'model', ['a-1']]]); // after the CV's l-1…l-5
  const letter = t.cap.calls.find((c) => c.pipeline === 'career-letter')!;
  expect(letter.input).toContain(`"answer":"${ANSWER}"`);
  expect(letter.input).not.toContain('Why Marlowe'); // a skipped question is not sent
  expect(letter.input).toContain('"id":"c-1"');
  expect(letter.input).not.toContain('Takes referrals'); // assumptions stay out of the letter
  expect(letter.system?.rules).toMatch(/"team player"/);

  for (const v of ['Jane', 'jane.doe', '1234567', 'jane-doe.example']) expect(t.cap.text()).not.toContain(v);
  const logs = t.logs();
  for (const v of ['Canary', 'Series B', 'Kubernetes', 'Typed Co', 'marlowe.example', 'Netherlands', 'jane', 'Marlowe']) expect(logs).not.toContain(v);
  expect((await t.call('POST', `/${id}/answers`, { answers: [] })).json()).toEqual({ error: 'wrong_status' });
});

test('zero questions: no pause, the letter is written at once; a skipped answer id is not a valid cite', async () => {
  const t = await setup({ 'career-questions': () => ({ evidence: [], questions: [] }) });
  const { id } = (await t.call('POST', '', { posting: POSTING })).json() as { id: number };
  await t.drain();
  const d = await t.detail(id);
  // LETTER cites a-1, which no answer backs: the letter is retried once, then flagged.
  expect(d).toMatchObject({ status: 'flagged', step: 'letter_verify', fail_code: 'verify_failed', answers: null });
  expect(t.cap.calls.filter((c) => c.pipeline === 'career-letter')).toHaveLength(2);
  expect((d.verify as { violations: unknown[] }).violations).toContainEqual({ code: 'unknown_cite', ref: 'l-11', token: 'a-1' }); // the second letter's l-9…l-11
});

test('POST …/ats re-checks the current draft version; allowed statuses only; a provider error is 502 and stores nothing', async () => {
  let fail = false;
  const t = await setup({
    'career-ats': () => {
      if (fail) throw new LlmError('overloaded', 'provider error 529', 529);
      return RUBRIC;
    },
  });
  const { id } = (await t.call('POST', '', FORM)).json() as { id: number };
  expect((await t.call('POST', `/${id}/ats`)).json()).toEqual({ error: 'wrong_status' }); // processing, no draft yet
  await t.drain(); // needs_answers
  const res = await t.call('POST', `/${id}/ats`);
  expect(res.statusCode).toBe(200);
  const ats = (res.json() as { ats: { score: number; history: unknown[]; parts: { name: string; score: number }[] } }).ats;
  expect(ats.history).toHaveLength(2);
  expect(ats.parts.slice(6).map((p) => p.score)).toEqual([8, 6, 7, 9]);
  expect(ats.score).toBe(Math.round(ats.parts.reduce((n, p) => n + p.score, 0)));
  fail = true;
  expect([(await t.call('POST', `/${id}/ats`)).statusCode, t.db.prepare("SELECT count(*) FROM application_texts WHERE kind = 'ats'").pluck().get()]).toEqual([502, 2]);
  t.db.prepare("UPDATE applications SET status = 'failed' WHERE id = ?").run(id);
  expect((await t.call('POST', `/${id}/ats`)).json()).toEqual({ error: 'wrong_status' });
  expect((await t.call('POST', '/999/ats')).json()).toEqual({ error: 'not_found' });
  expect(t.logs()).not.toContain('Cut deploy');
});

test('PATCH …/gaps dismisses suggestions; PUT …/draft keeps origin suggestion only for an open suggestion id', async () => {
  const t = await setup({ 'career-questions': () => ({ evidence: [], questions: [] }), 'career-letter': () => ({ paragraphs: LETTER.paragraphs.slice(0, 2).concat([{ ...LETTER.paragraphs[1]! }]) }) });
  const { id } = (await t.call('POST', '', { posting: POSTING })).json() as { id: number };
  await t.drain();
  expect((await t.detail(id)).status).toBe('draft_ready');
  expect((await t.call('PATCH', `/${id}/gaps`, { dismissed: ['s-9'] })).json()).toEqual({ error: 'unknown_suggestion' });
  const patched = (await t.call('PATCH', `/${id}/gaps`, { dismissed: ['s-1', 's-1'] })).json() as { gaps: { dismissed: string[] } };
  expect(patched.gaps.dismissed).toEqual(['s-1']);

  const d = await t.detail(id);
  const skills = d.draft.cv.sections.find((s) => s.name === 'Skills')!;
  const put = await t.call('PUT', `/${id}/draft`, {
    versions: d.draft.versions,
    cv: {
      sections: d.draft.cv.sections.map((s) =>
        s === skills && 'bullets' in s
          ? { ...s, bullets: [...s.bullets, { text: 'Kubernetes', origin: 'suggestion', suggestion_id: 's-2' }, { text: 'Helm', origin: 'suggestion', suggestion_id: 's-1' }, { text: 'Go', origin: 'suggestion' }] }
          : s,
      ),
    },
    letter: d.draft.letter,
  });
  expect(put.statusCode).toBe(200);
  const after = (put.json() as { draft: Draft }).draft.cv.sections.find((s) => s.name === 'Skills')!;
  expect('bullets' in after && after.bullets.slice(-3).map(({ text, origin, suggestion_id }) => ({ text, origin, suggestion_id }))).toEqual([
    { text: 'Kubernetes', origin: 'suggestion', suggestion_id: 's-2' },
    { text: 'Helm', origin: 'owner', suggestion_id: undefined }, // dismissed
    { text: 'Go', origin: 'owner', suggestion_id: undefined }, // no id
  ]);
  expect(t.logs()).not.toMatch(/Helm|Kubernetes/);
});

test('retry after a failed letter step runs the whole agent again; old answers do not answer the new questions', async () => {
  let n = 0;
  const t = await setup({
    'career-letter': () => {
      if (n++ === 0) throw new LlmError('overloaded', 'provider error 529', 529);
      return LETTER;
    },
  });
  const { id } = (await t.call('POST', '', FORM)).json() as { id: number };
  await t.drain();
  await t.call('POST', `/${id}/answers`, { answers: [{ id: 'q-1', text: ANSWER }] });
  await t.drain();
  expect(await t.detail(id)).toMatchObject({ status: 'failed', step: 'letter', fail_code: 'provider_error' });
  retryRun(t.db, id, 'h2');
  await t.drain();
  expect(await t.detail(id)).toMatchObject({ status: 'needs_answers', answers: null }); // new questions, unanswered
  await t.call('POST', `/${id}/answers`, { answers: [{ id: 'q-1', text: ANSWER }] });
  await t.drain();
  expect(await t.detail(id)).toMatchObject({ status: 'draft_ready', answers: { questions_version: 2 } });
});

// ---------- pure parts ----------

test('hasWord: whole words, case-insensitive; in_master searches the master text, not its ids', () => {
  expect(hasWord('Java and C++ here', 'java')).toBe(true);
  expect(hasWord('JavaScript only', 'Java')).toBe(false);
  expect(hasWord('C++ and Go', 'C++')).toBe(true);
  expect(hasWord('GitHub   Actions', 'github actions')).toBe(true);
  expect(hasWord('anything', '  ')).toBe(false);
  const text = masterText(readMasterFixture());
  expect(hasWord(text, 'terraform')).toBe(true);
  expect(hasWord(text, 'Hamburg')).toBe(true);
  expect(hasWord(text, 'skill')).toBe(false); // `^skill-terraform` ids are not text
});

function readMasterFixture() {
  const vault = mkdtempSync(join(tmpdir(), 'aos-letter-'));
  dirs.push(vault);
  mkdirSync(join(vault, 'career'));
  copyFileSync(join(FIXTURES, 'master.md'), join(vault, 'career', 'master.md'));
  return readMaster(vault);
}

test('verbatim: substrings up to whitespace, 3+ characters', () => {
  expect(verbatim('deploy  times', 'improve deploy\ntimes')).toBe(true);
  expect(verbatim('Deploy times', 'improve deploy times')).toBe(false);
  expect(verbatim('ab', 'ab')).toBe(false);
  expect(verbatim(null, 'x')).toBe(false);
  expect(verbatim('b', 'a', 'abc')).toBe(false);
  expect(verbatim('abc', 'x', 'zabcz')).toBe(true);
});

test('atsCode: the arithmetic of each code check', () => {
  const line = (id: string, text: string) => ({ id, text, cites: [], origin: 'owner' as const });
  const d: Draft = {
    v: 2,
    cv: {
      sections: [
        { name: 'Summary', bullets: [line('l-1', 'Platform engineer.')] },
        {
          name: 'Experience',
          entries: [
            { id: 'e-1', org: 'A', title: 'T', start: '2021-03', end: 'present', location: '', bullets: [line('l-2', 'Terraform on AWS daily.'), line('l-3', 'x'.repeat(300))] },
            { id: 'e-2', org: 'B', title: 'T', start: '', end: '', location: '', bullets: [] },
          ],
        },
      ],
    },
    letter: { paragraphs: [] },
    versions: 3,
  };
  const req = {
    must_have: [
      { id: 'must-1', text: 'Terraform and AWS', kind: 'skill' as const }, // both terms: found
      { id: 'must-2', text: 'Kubernetes and Helm', kind: 'skill' as const }, // none: missing
      { id: 'must-3', text: '5+ years', kind: 'experience' as const }, // no terms left: not counted
    ],
    nice_to_have: [{ id: 'nice-1', text: 'Platform tooling', kind: 'skill' as const }], // half the terms: found
  };
  const { parts, findings } = atsCode(d, req, { name: 'N', email: 'e@x.y' });
  expect(Object.fromEntries(parts.map((p) => [p.name, [p.score, p.max]]))).toEqual({
    keywords: [18, 30], // (2 + 1) / (2 + 2 + 1) of 30
    sections: [6.7, 10], // Skills missing: 2 of 3
    length: [0, 5], // far under 350 words
    dates: [2.5, 5], // one of two entries dated
    contact: [3.3, 5], // phone missing
    bullets: [3.3, 5], // one of three lines at 300 characters
  });
  expect(parts.find((p) => p.name === 'keywords')!.notes).toEqual(['Not found: Kubernetes and Helm']);
  expect(parts.find((p) => p.name === 'contact')!.notes).toEqual(['Not set in contact.md: phone']);
  expect(findings.map((f) => f.severity)).toEqual(['medium', 'high', 'medium', 'medium', 'high', 'low']);
  expect(JSON.stringify(parts)).not.toContain('e@x.y');
});
