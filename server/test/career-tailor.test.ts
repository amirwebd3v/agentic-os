import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { loadContact } from '../src/career/contact.ts';
import type { Requirements } from '../src/career/intake.ts';
import { parseMaster } from '../src/career/master.ts';
import { Draft, draftLines, toDraftV2 } from '../src/career/draft.ts';
import { indexMaster, readMaster, writeDraft } from '../src/career/tailor.ts';
import type { DraftV1, MasterIndex, Selection } from '../src/career/tailor.ts';
import { verifyDraft } from '../src/career/verify.ts';
import { parseConfig } from '../src/config.ts';
import { enqueue } from '../src/db/jobs.ts';
import { failCareerJob, retryRun } from '../src/http/routes/career.ts';
import { careerDraft } from '../src/jobs/career-draft.ts';
import { careerIntake } from '../src/jobs/career-intake.ts';
import { careerMatch } from '../src/jobs/career-match.ts';
import { careerAts, careerCompany, careerGaps, careerLetter, careerLetterVerify, careerQuestions, careerVacancy } from '../src/jobs/career-steps.ts';
import { careerVerify } from '../src/jobs/career-verify.ts';
import { runNext } from '../src/jobs/runner.ts';
import { LlmError } from '../src/llm/errors.ts';
import { parseNote } from '../src/vault/frontmatter.ts';
import { capturePrompts, makeTestDb } from './helpers.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'career');
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
/** A temp vault with the synthetic master and contact (contract §1). */
function vault(files = ['master.md', 'contact.md']) {
  const dir = mkdtempSync(join(tmpdir(), 'aos-tailor-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'career'));
  for (const f of files) copyFileSync(join(FIXTURES, f), join(dir, 'career', f));
  return parseConfig({ vaultDir: dir, dataDir: join(tmpdir(), 'aos-tailor-data') });
}
const config = vault();
const M = readMaster(config.vaultDir);
const CONTACT = loadContact(config.vaultDir);

const N = 'exp-northwind-logistics-2021';
const K = 'exp-kestrel-data-2018';
const REQ: Requirements = {
  language: 'en',
  company: 'Marlowe Freight Technologies',
  role_title: 'Platform Engineer',
  seniority: 'senior',
  location_mode: 'hybrid',
  must_have: [
    { id: 'must-1', text: 'Terraform and AWS', kind: 'skill' },
    { id: 'must-2', text: 'Python or Bash scripting', kind: 'skill' },
    { id: 'must-3', text: '4+ years in a platform role', kind: 'experience' },
    { id: 'must-4', text: 'Fluent English', kind: 'language' },
  ],
  nice_to_have: [
    { id: 'nice-1', text: 'GitHub Actions', kind: 'skill' },
    { id: 'nice-2', text: 'Basic German', kind: 'language' },
  ],
  injection_suspected: false,
};
/** What the intake model answers for that: ids come from code. */
const INTAKE = { ...REQ, must_have: REQ.must_have.map(({ text, kind }) => ({ text, kind })), nice_to_have: REQ.nice_to_have.map(({ text, kind }) => ({ text, kind })) };
const SELECTION = {
  picks: [
    { requirement_id: 'must-1', bullet_ids: [`${N}-4d5e6f`, 'skill-terraform', 'skill-aws'] },
    { requirement_id: 'must-2', bullet_ids: [`${N}-7a8b9c`] },
    { requirement_id: 'must-4', bullet_ids: ['lang-english'] },
    { requirement_id: 'nice-1', bullet_ids: [`${N}-1a2b3c`] },
    { requirement_id: 'nice-2', bullet_ids: [] },
  ],
  entries: [
    { entry_id: N, bullet_ids: [`${N}-1a2b3c`, `${N}-4d5e6f`, `${N}-7a8b9c`] },
    { entry_id: K, bullet_ids: [`${K}-0a1b2c`] },
  ],
  skill_ids: ['skill-terraform', 'skill-aws', 'skill-python', 'skill-bash'],
};

/** A draft the verifier passes: light rewording, every claim cited. */
const good = () => ({
  summary: { text: 'Platform engineer with 6 years in DevOps and cloud infrastructure.', cites: ['sum-1'] },
  entries: [
    {
      entry_id: N,
      bullets: [
        { text: 'Cut deploy time from 40 to 9 minutes by moving CI to GitHub Actions.', cites: [`${N}-1a2b3c`] },
        { text: 'Automated AWS infrastructure (ECS, RDS, IAM) with Terraform across 3 accounts.', cites: [`${N}-4d5e6f`] },
        { text: 'Built Python and Bash tooling for on-call runbooks.', cites: [`${N}-7a8b9c`] },
      ],
    },
    { entry_id: K, bullets: [{ text: 'Ran 120 Linux servers against a 99,9 % uptime target.', cites: [`${K}-0a1b2c`] }] },
  ],
  skill_ids: ['skill-terraform', 'skill-aws'],
  // 286 words (250–350): sentences repeated, every claim cited.
  letter: {
    paragraphs: [
      { text: `I am applying for the Platform Engineer role at Marlowe Freight Technologies.${' My work covers 6 years in DevOps and cloud infrastructure.'.repeat(9)}`, cites: ['sum-1'] },
      { text: 'At Northwind Logistics in Hamburg I cut deploy time from 40 to 9 minutes and automated AWS with Terraform since 2021. '.repeat(5).trim(), cites: [`${N}-1a2b3c`, `${N}-4d5e6f`] },
      { text: `${'I write Python and Bash tooling and speak English at C1 level. '.repeat(6)}You can reach me at {{CONTACT_EMAIL}}.`, cites: [`${N}-7a8b9c`, 'lang-english'] },
    ],
  },
});
/** An invented number, an unknown cite and a leaked e-mail (acceptance). */
const bad = () => {
  const d = good();
  d.entries[0]!.bullets[0]!.text = 'Cut deploy time from 40 to 5 minutes by moving CI to GitHub Actions.';
  d.entries[0]!.bullets[1]!.cites = [`${N}-ffffff`];
  d.letter.paragraphs[2]!.text = 'Write to jane.doe@example.com any time.';
  return d;
};
/** The model's answer as `writeDraft` stores it. Ids in document order for the fixture master: summary l-1;
 * Northwind e-1 (l-2, l-3, l-4); Kestrel e-2 (l-5); skills l-6, l-7; languages l-8, l-9; letter l-10, l-11, l-12. */
const asDraft = (d: ReturnType<typeof good>, m: MasterIndex = M): Draft => toDraftV2({ ...d, versions: 1 }, m.master, true);
const verify = (d: ReturnType<typeof good>, m = M) => verifyDraft(asDraft(d, m), m, REQ, CONTACT);
const lineOf = (d: Draft, id: string) => [...draftLines(d)].find((x) => x.line.id === id)!.line;

// ---------- verifier: one fixture per rule (contract §6) ----------

test('a cited, lightly reworded draft passes', () => {
  expect(verify(good())).toEqual({ ok: true, violations: [] });
});

test.each([
  ['missing_cite', (d) => (d.summary.cites = []), { code: 'missing_cite', ref: 'l-1' }],
  ['missing_cite (> 5)', (d) => (d.summary.cites = Array(6).fill('sum-1')), { code: 'missing_cite', ref: 'l-1' }],
  ['unknown_cite', (d) => (d.entries[0]!.bullets[1]!.cites = [`${N}-ffffff`]), { code: 'unknown_cite', ref: 'l-3', token: `${N}-ffffff`.slice(0, 40) }],
  ['unknown_cite (an entry id is not a source)', (d) => (d.letter.paragraphs[0]!.cites = [N]), { code: 'unknown_cite', ref: 'l-10', token: N }],
  ['unknown_cite (entry)', (d) => (d.entries[1]!.entry_id = 'exp-nowhere-2020'), { code: 'unknown_cite', ref: 'e-2', token: 'exp-nowhere-2020' }],
  ['wrong_entry', (d) => (d.entries[1]!.bullets[0]!.cites = [`${N}-1a2b3c`]), { code: 'wrong_entry', ref: 'l-5', token: `${N}-1a2b3c` }],
  ['wrong_entry (a skill under an entry)', (d) => d.entries[0]!.bullets[2]!.cites.push('skill-python'), { code: 'wrong_entry', ref: 'l-4', token: 'skill-python' }],
  ['unsupported_number', (d) => (d.entries[0]!.bullets[0]!.text = 'Cut deploy time from 40 to 5 minutes.'), { code: 'unsupported_number', ref: 'l-2', token: '5' }],
  ['unsupported_number (a year inside a longer one)', (d) => (d.letter.paragraphs[1]!.text = 'Since 21 I cut deploy time.'), { code: 'unsupported_number', ref: 'l-11', token: '21' }],
  ['unsupported_entity (en capitalised word)', (d) => (d.entries[0]!.bullets[2]!.text = 'Built Python tooling on Kubernetes.'), { code: 'unsupported_entity', ref: 'l-4', token: 'Kubernetes' }],
  ['unsupported_entity (acronym)', (d) => (d.summary.text = 'Platform engineer with 6 years in DevOps and GCP.'), { code: 'unsupported_entity', ref: 'l-1', token: 'GCP' }],
  ['unsupported_entity (symbol)', (d) => (d.entries[0]!.bullets[2]!.text = 'Built Python and Node.js tooling.'), { code: 'unsupported_entity', ref: 'l-4', token: 'Node.js' }],
  ['unsupported_entity (a word of the company, not the whole name)', (d) => (d.letter.paragraphs[0]!.text = 'I like how Marlowe works.'), { code: 'unsupported_entity', ref: 'l-10', token: 'Marlowe' }],
  ['unknown_cite (free text is never a token)', (d) => (d.summary.cites = ['Jane Doe wrote this']), { code: 'unknown_cite', ref: 'l-1' }],
  ['unsupported_entity (company outside the letter)', (d) => (d.entries[0]!.bullets[2]!.text = 'Built Python tooling like Marlowe needs.'), { code: 'unsupported_entity', ref: 'l-4', token: 'Marlowe' }],
  ['contact_leak (e-mail)', (d) => (d.letter.paragraphs[2]!.text = 'Write to jane.doe@example.com any time.'), { code: 'contact_leak', ref: 'l-12' }],
  ['contact_leak (phone)', (d) => (d.letter.paragraphs[2]!.text = 'Call +44 20 7946 0958.'), { code: 'contact_leak', ref: 'l-12' }],
  ['contact_leak (url)', (d) => (d.letter.paragraphs[2]!.text = 'See https://portfolio.example.org/me for more.'), { code: 'contact_leak', ref: 'l-12' }],
  ['contact_leak (the contact name)', (d) => (d.letter.paragraphs[2]!.text = 'Regards, jane mary doe'), { code: 'contact_leak', ref: 'l-12' }],
  ['bad_placeholder', (d) => (d.letter.paragraphs[2]!.text = 'My tax id is {{CONTACT_TAX}}.'), { code: 'bad_placeholder', ref: 'l-12', token: '{{CONTACT_TAX}}' }],
  ['too_long', (d) => (d.entries[0]!.bullets[2]!.text = `Built tooling ${'and more '.repeat(40)}`), { code: 'too_long', ref: 'l-4' }],
  ['too_many_lines (CV)', (d) => (d.entries[0]!.bullets = Array.from({ length: 19 }, () => d.entries[0]!.bullets[0]!)), { code: 'too_many_lines', ref: 'cv' }],
  ['too_many_lines (letter)', (d) => d.letter.paragraphs.pop(), { code: 'too_many_lines', ref: 'letter' }],
] as [string, (d: ReturnType<typeof good>) => unknown, object][])('%s', (_, mutate, violation) => {
  const d = good();
  mutate(d);
  const report = verify(d);
  expect(report.ok).toBe(false);
  expect(report.violations).toContainEqual(violation);
});

test('letters may name the company, role and the cited entry; German skips capitalised nouns but not acronyms', () => {
  const de = `${readFileSync(join(FIXTURES, 'master.md'), 'utf8').replace(/## Summary[\s\S]*/, '')}## Experience\n### Nordwind GmbH | Entwicklerin | 2020 | present | Hamburg  ^exp-nordwind-2020\n- Betrieb der Server mit Terraform und der Datenbank für das Team.  ^exp-nordwind-2020-aaaaaa\n`;
  const m = indexMaster(parseMaster(de), parseNote(de).body);
  expect(m.language).toBe('de');
  const d = good();
  d.summary = { text: 'Betrieb der Plattform mit Terraform.', cites: ['exp-nordwind-2020-aaaaaa'] }; // Plattform: a noun, not an entity in German
  d.entries = [{ entry_id: 'exp-nordwind-2020', bullets: [{ text: 'Betrieb der Server mit SAP.', cites: ['exp-nordwind-2020-aaaaaa'] }] }];
  d.skill_ids = [];
  d.letter.paragraphs = d.letter.paragraphs.map(() => ({ text: 'Bei Nordwind GmbH in Hamburg seit 2020. '.repeat(15).trim(), cites: ['exp-nordwind-2020-aaaaaa'] }));
  expect(verify(d, m).violations).toEqual([{ code: 'unsupported_entity', ref: 'l-1', token: 'SAP' }]); // that master has Experience only: it comes first
  expect(M.language).toBe('en');
});

test('v2: a model skill line must cite a master skill (cv.skills); owner and suggestion lines skip cite checks, not contact or placeholder checks', () => {
  const d = asDraft(good());
  const section = (name: string) => d.cv.sections.find((s) => s.name === name)!;
  const skills = section('Skills') as Extract<Draft['cv']['sections'][number], { bullets: unknown }>;
  skills.bullets.push({ id: 'l-50', text: 'Kubernetes', cites: ['skill-kubernetes'], origin: 'model' }, { id: 'l-51', text: 'Rust', cites: [], origin: 'owner' });
  const exp = section('Experience') as Extract<Draft['cv']['sections'][number], { entries: unknown }>;
  exp.entries[0]!.bullets.push(
    { id: 'l-52', text: 'Led 40 people on Kubernetes at Acme.', cites: [], origin: 'owner' },
    { id: 'l-53', text: 'Mail jane.doe@example.com for SAP work.', cites: [], origin: 'suggestion' },
  );
  d.cv.sections.push({
    name: 'Projects',
    entries: [{ id: 'e-9', org: 'Side project', title: '', start: '', end: '', location: '', bullets: [{ id: 'l-54', text: 'Wrote a {{CONTACT_TAX}} tool.', cites: [], origin: 'owner' }] }],
  });
  const { violations } = verifyDraft(d, M, REQ, CONTACT);
  expect(violations).toEqual([
    { code: 'contact_leak', ref: 'l-53' },
    { code: 'unknown_cite', ref: 'cv.skills', token: 'skill-kubernetes' },
    { code: 'bad_placeholder', ref: 'l-54', token: '{{CONTACT_TAX}}' },
  ]);
});

test('toDraftV2: a stored v1 draft becomes v2 in master section order, without removed items, with the user edits kept', () => {
  const E = 'edu-hochschule-bremen-2015';
  const v1: DraftV1 = {
    summary: { text: 'S', cites: ['sum-1'], removed: true },
    entries: [
      { entry_id: E, bullets: [{ text: 'Thesis.', cites: [`${E}-6a7b8c`] }] },
      { entry_id: N, header: { title: 'Platform Lead', location: '' }, bullets: [{ text: 'A', cites: [`${N}-1a2b3c`], removed: true }, { text: 'Mine', cites: [] }] },
      { entry_id: K, removed: true, bullets: [{ text: 'gone', cites: [`${K}-0a1b2c`] }] },
    ],
    skill_ids: ['skill-aws', 'skill-cobol'],
    languages_text: 'English, German',
    letter: { paragraphs: [{ text: 'P0', cites: ['sum-1'] }, { text: 'P1', cites: [], removed: true }, { text: 'P2', cites: [] }] },
    versions: 4,
  };
  const d = toDraftV2(v1, M.master);
  expect(Draft.parse(d)).toEqual(d);
  expect(d).toEqual({
    v: 2,
    cv: {
      sections: [
        {
          name: 'Experience',
          entries: [{ id: 'e-1', source: N, org: 'Northwind Logistics', title: 'Platform Lead', start: '2021-03', end: 'present', location: '', bullets: [{ id: 'l-1', text: 'Mine', cites: [], origin: 'owner' }] }],
        },
        {
          name: 'Education',
          entries: [
            { id: 'e-2', source: E, org: 'Hochschule Bremen', title: 'BSc Computer Science', start: '2015', end: '2018', location: 'Bremen', bullets: [{ id: 'l-2', text: 'Thesis.', cites: [`${E}-6a7b8c`], origin: 'model' }] },
          ],
        },
        { name: 'Skills', bullets: [{ id: 'l-3', text: 'AWS', cites: ['skill-aws'], origin: 'model' }] }, // an unknown skill id has no text: dropped
        { name: 'Languages', bullets: [{ id: 'l-4', text: 'English', cites: [], origin: 'owner' }, { id: 'l-5', text: 'German', cites: [], origin: 'owner' }] },
      ],
    },
    letter: { paragraphs: [{ id: 'l-6', text: 'P0', cites: ['sum-1'], origin: 'model' }, { id: 'l-7', text: 'P2', cites: [], origin: 'owner' }] },
    versions: 4,
  });
  expect(toDraftV2(d, null)).toBe(d); // a v2 draft stays as it is

  // Without a master: headers from the user's edits only, skills by id are lost, every entry sits under Experience.
  const bare = toDraftV2(v1, null);
  expect(bare.cv.sections.map((s) => s.name)).toEqual(['Experience', 'Languages']);
  expect(bare.cv.sections[0]).toMatchObject({ entries: [{ id: 'e-1', source: E, org: '' }, { id: 'e-2', source: N, org: '', title: 'Platform Lead', start: '' }] });
  // The master's languages when the user never edited them.
  expect(toDraftV2({ ...v1, languages_text: undefined }, M.master).cv.sections.at(-1)).toEqual({
    name: 'Languages',
    bullets: [
      { id: 'l-4', text: 'English (C1)', cites: ['lang-english'], origin: 'model' },
      { id: 'l-5', text: 'German (native)', cites: ['lang-german'], origin: 'model' },
    ],
  });
});

test('the acceptance draft: invented number, unknown cite and leaked e-mail, each with its code; tokens ≤ 40 chars', () => {
  const { ok, violations } = verify(bad());
  expect(ok).toBe(false);
  expect(violations).toEqual(
    expect.arrayContaining([
      { code: 'unsupported_number', ref: 'l-2', token: '5' },
      { code: 'unknown_cite', ref: 'l-3', token: `${N}-ffffff`.slice(0, 40) },
      { code: 'contact_leak', ref: 'l-12' },
    ]),
  );
  expect(violations.every((v) => (v.token ?? '').length <= 40)).toBe(true);
  expect(JSON.stringify(violations)).not.toContain('jane');
});

test('adversarial model output: hidden characters and full-width digits are normalised before the check; the master language is used', async () => {
  const d = good();
  d.entries[0]!.bullets[2]!.text = 'Built Python on Kuber​netes\nwith ５ teams.';
  const cap = capturePrompts(() => d);
  const draft = await writeDraft({ db: makeTestDb(), config, contact: CONTACT, llm: cap.llm }, M, REQ, SELECTION as Selection);
  expect(lineOf(draft, 'l-4')).toEqual({ id: 'l-4', text: 'Built Python on Kubernetes with 5 teams.', cites: [`${N}-7a8b9c`], origin: 'model' });
  expect(draft.versions).toBe(1);
  expect(cap.calls[0]!.system?.rules).toMatch(/Write in English/);
  expect(verifyDraft(draft, M, REQ, CONTACT).violations).toEqual(
    expect.arrayContaining([
      { code: 'unsupported_entity', ref: 'l-4', token: 'Kubernetes' },
      { code: 'unsupported_number', ref: 'l-4', token: '5' },
    ]),
  );
});

test.each([
  ['cliche', (d) => (d.letter.paragraphs[0]!.text += ' I am a Team-Player.'), { code: 'cliche', ref: 'l-10', token: 'team player' }],
  ['letter_length (too short)', (d) => (d.letter.paragraphs[2]!.text = 'I write Python.'), { code: 'letter_length', ref: 'letter' }],
  ['letter_length (too long)', (d) => (d.letter.paragraphs[2]!.text = 'I write Python and Bash tooling. '.repeat(40)), { code: 'letter_length', ref: 'letter' }],
  ['unknown_cite (an answer id with no answer)', (d) => (d.letter.paragraphs[2]!.cites = ['a-1']), { code: 'unknown_cite', ref: 'l-12', token: 'a-1' }],
] as [string, (d: ReturnType<typeof good>) => unknown, object][])('letter: %s', (_, mutate, violation) => {
  const d = good();
  mutate(d);
  expect(verify(d).violations).toContainEqual(violation);
});

test('letter: an answer id is a valid cite with its answer text as the source, in the letter only; the CV-only check skips the letter', () => {
  const d = asDraft(good());
  d.letter.paragraphs[2] = { ...d.letter.paragraphs[2]!, text: `${d.letter.paragraphs[2]!.text} I moved 4 teams to Kubernetes.`, cites: [...d.letter.paragraphs[2]!.cites, 'a-1'] };
  const sources = new Map([['a-1', 'I moved 4 teams to Kubernetes last year.']]);
  expect(verifyDraft(d, M, REQ, CONTACT, { sources })).toEqual({ ok: true, violations: [] });
  expect(verifyDraft(d, M, REQ, CONTACT).violations).toEqual(
    expect.arrayContaining([{ code: 'unknown_cite', ref: 'l-12', token: 'a-1' }, { code: 'unsupported_entity', ref: 'l-12', token: 'Kubernetes' }]),
  );
  const cv = lineOf(d, 'l-2');
  cv.cites = ['a-1']; // a CV line can't cite an answer
  expect(verifyDraft(d, M, REQ, CONTACT, { sources }).violations).toContainEqual({ code: 'unknown_cite', ref: 'l-2', token: 'a-1' });
  expect(verifyDraft({ ...d, letter: { paragraphs: [] } }, M, REQ, CONTACT, { letter: false }).violations.some((v) => v.ref === 'letter')).toBe(false);
});

// ---------- the pipeline with the real runner (career-v2.md §5) ----------

const POSTING = `${readFileSync(join(FIXTURES, 'posting-en.txt'), 'utf8')}\nQuestions: ask JANE.DOE@EXAMPLE.COM or Jane Mary Doe, +49 30 123 45 67.`;

/** Every place the contract says holds ids, counts and codes only. */
const stored = (db: ReturnType<typeof makeTestDb>) =>
  JSON.stringify([
    db.prepare('SELECT kind, payload, error FROM jobs').all(),
    db.prepare('SELECT error FROM llm_calls').all(),
    db.prepare('SELECT action, args_redacted FROM audit_log').all(),
    db.prepare('SELECT kind, detail FROM application_events').all(),
  ]);

const GAPS = () => ({
  missing_keywords: [{ keyword: 'Kubernetes', importance: 'must' }, { keyword: 'terraform', importance: 'nice' }, { keyword: 'Kubernetes', importance: 'nice' }],
  weak_sections: [{ section: 'Summary', problem: 'It does not name the freight domain.' }],
  formatting: [],
  suggestions: [
    { section: 'Experience', entry_id: N, text: 'Ran Kubernetes clusters for [number] product teams.', why: 'The posting asks for Kubernetes.', keyword: 'Kubernetes' },
    { section: 'Skills', entry_id: 'exp-nowhere-2020', text: 'Kubernetes', why: 'A skill the posting names.', keyword: null },
  ],
});
/** Quotes verbatim except seniority's (dropped: 0 points). */
const RUBRIC = () => ({
  relevance: { score: 8, cv_quote: 'Cut deploy time from 40 to 9 minutes', posting_quote: 'improve deploy times', note: 'Directly relevant.' },
  seniority: { score: 9, cv_quote: 'Led a team of 12', posting_quote: 'Senior level.', note: 'Invented quote.' },
  skills: { score: 7.5, cv_quote: 'Terraform', posting_quote: 'Terraform and AWS (ECS, RDS, IAM)', note: 'Most skills match.' },
  clarity: { score: 12, cv_quote: 'Platform  engineer\nwith 6 years', posting_quote: 'Hybrid, Rotterdam office', note: 'Clear.' },
  findings: [{ severity: 'medium', text: 'No Kubernetes.' }],
});
const COMPANY = () => ({
  points: [
    { text: 'Builds route-planning software for regional freight carriers.', quote: 'Marlowe builds route-planning software for regional freight carriers.' },
    { text: 'Doubled revenue last year.', quote: 'They doubled revenue in 2025.' }, // not in the sources: an assumption
    { text: 'Values autonomy.', quote: null },
  ],
});
const item = (text: string, quotes: string[]) => ({ text, quotes });
const VACANCY = () => ({
  why_open: item('The platform needs an owner.', ['Maintain our CI/CD pipelines and internal developer platform']),
  business_problem: item('Deploys are slow.', ['Work with product teams to improve deploy times']),
  outcomes: [item('Faster deploys.', ['improve deploy times']), item('Automated infrastructure.', ['Automate infrastructure with Terraform on AWS']), item('A platform.', []), item('Extra.', [])],
  priorities: [item('Kubernetes migration.', ['Migrate to Kubernetes'])],
});
const QUESTIONS = (n = 0) => () => ({
  evidence: [{ need: 'Faster deploys', master_ids: [`${N}-1a2b3c`, 'invented-id'] }],
  questions: Array.from({ length: n }, (_, i) => ({ text: `Question ${i + 1}?`, why: 'The letter needs it.' })),
});
const LETTER = () => ({ paragraphs: good().letter.paragraphs });

type Answer = () => unknown;
function pipeline(answers: { match?: Answer; drafts?: Answer[]; letters?: Answer[]; questions?: Answer; by?: Record<string, Answer> } = {}, cfg = config, step = 'intake') {
  const db = makeTestDb();
  const id = Number(db.prepare(`INSERT INTO applications (step, master_hash) VALUES (?, 'h') RETURNING id`).pluck().get(step));
  db.prepare(`INSERT INTO application_texts (application_id, kind, body) VALUES (?, 'posting', ?)`).run(id, POSTING);
  if (step === 'intake') enqueue(db, 'career_intake', `career:intake:${id}:0`, { applicationId: id });
  else {
    db.prepare(`INSERT INTO application_texts (application_id, kind, body) VALUES (?, 'requirements', ?)`).run(id, JSON.stringify(REQ));
    enqueue(db, 'career_match', `career:match:${id}:0`, { applicationId: id });
  }
  const drafts = [...(answers.drafts ?? [good])];
  const letters = [...(answers.letters ?? [LETTER])];
  const by: Record<string, Answer> = {
    'career-intake': () => INTAKE,
    'career-match': answers.match ?? (() => SELECTION),
    'career-gaps': GAPS,
    'career-draft': () => drafts.shift()!(),
    'career-ats': RUBRIC,
    'career-company': COMPANY,
    'career-vacancy': VACANCY,
    'career-questions': answers.questions ?? QUESTIONS(0),
    'career-letter': () => letters.shift()!(),
    ...answers.by,
  };
  const cap = capturePrompts((req) => by[req.pipeline]!());
  const deps = { db, config: cfg, llm: cap.llm };
  const handlers = {
    career_intake: careerIntake(deps), career_match: careerMatch(deps), career_gaps: careerGaps(deps), career_draft: careerDraft(deps), career_verify: careerVerify(deps),
    career_ats: careerAts(deps), career_company: careerCompany(deps), career_vacancy: careerVacancy(deps), career_questions: careerQuestions(deps),
    career_letter: careerLetter(deps), career_letter_verify: careerLetterVerify(deps),
  };
  const run = async () => {
    for (;;) {
      try {
        if (!(await runNext(db, handlers, (job) => failCareerJob(db, job)))) return;
      } catch {
        // a thrown handler: the runner already marked the job and the application
      }
    }
  };
  const app = () => db.prepare('SELECT status, step, fail_code FROM applications WHERE id = ?').get(id);
  const jobs = () => db.prepare('SELECT idempotency_key AS key, status FROM jobs ORDER BY id').all() as { key: string; status: string }[];
  const keys = () => jobs().map((j) => j.key.replace(`:${id}:`, ':'));
  const texts = (kind: string) => db.prepare('SELECT body FROM application_texts WHERE kind = ? ORDER BY version').pluck().all(kind).map((b) => JSON.parse(b as string));
  return { db, id, cap, run, app, jobs, keys, texts };
}

const FULL_RUN = ['intake:0', 'match:0', 'gaps:0', 'draft:1', 'verify:1', 'ats:0', 'company:0', 'vacancy:0', 'questions:0', 'letter:1', 'letter_verify:1'].map((k) => `career:${k}`);
/** The CV as the draft step writes it (no letter yet), and with the letter after the letter step. */
const cvOnly = (d: ReturnType<typeof good>) => ({ ...asDraft(d), letter: { paragraphs: [] } });
const withLetter = (d: ReturnType<typeof good>, versions = 2) => ({ ...asDraft(d), versions });

test('intake → … → letter_verify: draft_ready; master cached, requirements not; no contact value in any prompt; no text in events or audit', async () => {
  const t = pipeline();
  await t.run();
  expect(t.app()).toEqual({ status: 'draft_ready', step: 'letter_verify', fail_code: null });
  expect(t.keys()).toEqual(FULL_RUN);
  expect(t.jobs().every((j) => j.status === 'done')).toBe(true);
  expect(t.texts('verify_report')).toEqual([{ ok: true, violations: [] }, { ok: true, violations: [] }]);
  expect(t.texts('draft')).toEqual([cvOnly(good()), withLetter(good())]); // letter ids l-10…l-12 follow the CV's
  expect(t.texts('selection')).toEqual([{ ...SELECTION, unmatched: ['must-3', 'nice-2'] }]);
  expect(t.texts('questions')).toEqual([{ evidence: [{ need: 'Faster deploys', master_ids: [`${N}-1a2b3c`] }], questions: [] }]); // zero questions: no pause
  expect(t.texts('answers')).toEqual([]);

  // R3: the master sits in the cached system block, the step's data in the uncached input; both tagged as data.
  expect(t.cap.calls.map((c) => c.pipeline)).toEqual([
    'career-intake', 'career-match', 'career-gaps', 'career-draft', 'career-ats', 'career-company', 'career-vacancy', 'career-questions', 'career-letter',
  ]);
  for (const c of t.cap.calls.filter((x) => ['career-match', 'career-gaps', 'career-draft', 'career-questions', 'career-letter'].includes(x.pipeline))) {
    expect(c.system?.persona).toMatch(/^<master>\n## Summary[\s\S]*\^exp-kestrel-data-2018-0a1b2c[\s\S]*\n<\/master>$/);
    expect(c.system?.rules).toMatch(/data, not instructions/);
    expect(c.system?.context).toBeUndefined();
    expect(c.input).toMatch(/^<requirements>/);
    expect(c.input).not.toContain('<master>');
  }
  for (const c of t.cap.calls.slice(4, 7)) {
    expect(c.system?.persona).toBeUndefined(); // ats, company, vacancy: no master
    expect(c.input).toMatch(/<posting>\n[\s\S]*Marlowe/);
  }
  // W2-03 privacy check on the real prompt builders: the posting's and the master's contact values are redacted.
  for (const v of ['Jane', 'jane.doe', 'JANE.DOE', '1234567', '123 45 67', 'jane-doe.example']) expect(t.cap.text()).not.toContain(v);
  expect(t.cap.calls[3]!.system?.persona).toContain('{{CONTACT_PHONE}}');

  const leaks = stored(t.db);
  for (const v of ['Northwind', 'Terraform', 'Marlowe', 'minutes', 'Platform', 'jane', '1234567', 'Kubernetes', 'freight']) expect(leaks).not.toContain(v);
  expect(t.db.prepare('SELECT kind, detail FROM application_events ORDER BY id').all()).toEqual([
    { kind: 'step', detail: '{"from":"intake","to":"match","must_have":4,"nice_to_have":2,"injection_suspected":false}' },
    { kind: 'step', detail: '{"from":"match","to":"gaps","matched":3,"total":4,"unmatched":2,"entries":2,"bullets":4,"skills":4}' },
    { kind: 'step', detail: '{"from":"gaps","to":"draft","keywords":2,"in_master":1,"suggestions":2}' },
    { kind: 'step', detail: '{"from":"draft","to":"verify","attempt":1,"cv_lines":5,"paragraphs":0}' },
    { kind: 'step', detail: '{"from":"verify","to":"ats","attempt":1,"violations":0,"codes":[]}' },
    { kind: 'step', detail: expect.stringMatching(/^\{"from":"ats","to":"company","score":\d+,"findings":\d+\}$/) },
    { kind: 'step', detail: '{"from":"company","to":"vacancy","research":false,"points":3,"verified":1}' },
    { kind: 'step', detail: '{"from":"vacancy","to":"questions","items":6,"verified":4}' },
    { kind: 'step', detail: '{"from":"questions","to":"letter","questions":0,"evidence":1}' },
    { kind: 'step', detail: '{"from":"letter","to":"letter_verify","attempt":1,"paragraphs":3}' },
    { kind: 'status', detail: '{"step":"letter_verify","status":"draft_ready","attempt":1,"violations":0,"codes":[]}' },
  ]);
});

test('gaps, ats, company and vacancy: in_master by code, ids by code, quotes checked in code', async () => {
  const t = pipeline();
  await t.run();
  const [gaps] = t.texts('gaps');
  expect(gaps).toEqual({
    missing_keywords: [{ keyword: 'Kubernetes', importance: 'must', in_master: false }, { keyword: 'terraform', importance: 'nice', in_master: true }], // the repeat is dropped
    weak_sections: [{ section: 'Summary', problem: 'It does not name the freight domain.' }],
    formatting: [],
    suggestions: [
      { id: 's-1', section: 'Experience', entry_id: N, text: 'Ran Kubernetes clusters for [number] product teams.', why: 'The posting asks for Kubernetes.', keyword: 'Kubernetes' },
      { id: 's-2', section: 'Skills', text: 'Kubernetes', why: 'A skill the posting names.' }, // an unknown entry id is dropped
    ],
    dismissed: [],
  });
  expect(t.cap.calls.find((c) => c.pipeline === 'career-gaps')!.system?.rules).toMatch(/Never present a suggestion as a fact/);

  const [ats] = t.texts('ats');
  const rubric = Object.fromEntries(ats.parts.slice(6).map((p: { name: string; score: number }) => [p.name, p.score]));
  expect(rubric).toEqual({ relevance: 8, seniority: 0, skills: 7.5, clarity: 10 }); // invented quote → 0; 12 clamped; whitespace-insensitive
  expect(ats.parts[7].notes).toEqual(['Not counted: its evidence quotes were not found word for word.']);
  expect(ats.score).toBe(Math.round(ats.parts.reduce((n: number, p: { score: number }) => n + p.score, 0)));
  expect(ats.draft_version).toBe(1);

  const [company] = t.texts('company');
  expect(company).toEqual({
    has_research: false,
    points: [
      { id: 'c-1', text: 'Builds route-planning software for regional freight carriers.', status: 'verified', quotes: ['Marlowe builds route-planning software for regional freight carriers.'] },
      { id: 'c-2', text: 'Doubled revenue last year.', status: 'assumption', quotes: [] },
      { id: 'c-3', text: 'Values autonomy.', status: 'assumption', quotes: [] },
    ],
  });
  const [vacancy] = t.texts('vacancy');
  expect(vacancy.outcomes).toHaveLength(3);
  expect(vacancy.why_open).toEqual({ id: 'v-1', text: 'The platform needs an owner.', status: 'verified', quotes: ['Maintain our CI/CD pipelines and internal developer platform'] });
  expect(vacancy.priorities).toEqual([{ id: 'v-6', text: 'Kubernetes migration.', status: 'assumption', quotes: [] }]);
  expect(t.cap.calls.find((c) => c.pipeline === 'career-company')!.input).toContain('<research>\n(none)\n</research>');
});

const badCv = () => {
  const d = bad();
  d.entries[1]!.bullets[0]!.text = 'Ran 120 Linux servers; write to jane.doe@example.com.';
  return d;
};

test('verify fails twice: attempt 2 gets the violations, the run goes on, letter_verify ends it flagged; no text stored outside application_texts', async () => {
  const t = pipeline({ drafts: [badCv, badCv, good] });
  await t.run();
  expect(t.app()).toEqual({ status: 'flagged', step: 'letter_verify', fail_code: 'verify_failed' });
  expect(t.keys()).toEqual([...FULL_RUN.slice(0, 5), 'career:draft:2', 'career:verify:2', ...FULL_RUN.slice(5)]);
  const reports = t.texts('verify_report');
  expect(reports).toHaveLength(3);
  const codes = ['unsupported_number', 'unknown_cite', 'unsupported_entity', 'contact_leak'];
  expect(reports[1]).toEqual(reports[0]);
  expect(reports[2]).toEqual(reports[1]); // the letter passes; the CV's violations remain
  expect([...new Set(reports[1].violations.map((v: { code: string }) => v.code))]).toEqual(codes);
  const retry = t.cap.calls[4]!;
  expect(retry.pipeline).toBe('career-draft');
  expect(retry.input).toMatch(/<violations>\n\[.*"code":"unsupported_number".*\]\n<\/violations>/);
  expect(retry.input).toContain('<previous_draft>');
  expect(retry.input).toContain('{{CONTACT_EMAIL}}'); // the leaked address in the previous draft is redacted before the model sees it
  expect(t.cap.text()).not.toMatch(/jane\.doe|1234567/i);
  expect(t.cap.calls.filter((c) => c.pipeline === 'career-letter')).toHaveLength(1); // CV violations never retry the letter
  const leaks = stored(t.db);
  for (const v of ['jane', 'ffffff', 'minutes', 'Northwind']) expect(leaks).not.toContain(v);
  expect(t.db.prepare("SELECT kind, detail FROM application_events WHERE kind IN ('retry', 'status') ORDER BY id").all()).toEqual([
    { kind: 'retry', detail: JSON.stringify({ from: 'verify', to: 'draft', attempt: 1, violations: reports[0].violations.length, codes }) },
    { kind: 'status', detail: JSON.stringify({ step: 'letter_verify', status: 'flagged', fail_code: 'verify_failed', attempt: 1, violations: reports[2].violations.length, codes }) },
  ]);
});

test('attempt 2 that passes ends draft_ready', async () => {
  const t = pipeline({ drafts: [bad, good] });
  await t.run();
  expect(t.app()).toEqual({ status: 'draft_ready', step: 'letter_verify', fail_code: null });
  expect(t.texts('draft')).toHaveLength(3);
  expect(t.texts('verify_report').map((r) => r.ok)).toEqual([false, true, true]);
});

test('a letter that fails its check gets one more attempt with its violations, then flagged; never a third', async () => {
  const cliche = () => {
    const l = LETTER();
    l.paragraphs[0]!.text += ' I am passionate about Kubernetes.';
    return l;
  };
  const t = pipeline({ letters: [cliche, cliche, LETTER] });
  await t.run();
  expect(t.app()).toEqual({ status: 'flagged', step: 'letter_verify', fail_code: 'verify_failed' });
  expect(t.keys().slice(-4)).toEqual(['career:letter:1', 'career:letter_verify:1', 'career:letter:2', 'career:letter_verify:2']);
  const second = t.cap.calls.filter((c) => c.pipeline === 'career-letter')[1]!;
  expect(second.input).toContain('<previous_letter>');
  expect(second.input).toMatch(/<violations>\n\[.*"code":"cliche","ref":"l-10","token":"passionate".*\]/);
  // Each letter takes new ids; versions count every write.
  expect(t.texts('draft').map((d) => [d.versions, d.letter.paragraphs.map((p: { id: string }) => p.id)])).toEqual([
    [1, []], [2, ['l-10', 'l-11', 'l-12']], [3, ['l-13', 'l-14', 'l-15']],
  ]);

  const u = pipeline({ letters: [cliche, LETTER] });
  await u.run();
  expect(u.app()).toEqual({ status: 'draft_ready', step: 'letter_verify', fail_code: null });
});

test('questions pause the run as needs_answers; letter jobs for it do nothing until answered', async () => {
  const t = pipeline({ questions: QUESTIONS(2) });
  await t.run();
  expect(t.app()).toEqual({ status: 'needs_answers', step: 'questions', fail_code: null });
  expect(t.keys()).toEqual(FULL_RUN.slice(0, 9));
  expect(t.texts('questions')[0].questions).toEqual([
    { id: 'q-1', text: 'Question 1?', why: 'The letter needs it.' },
    { id: 'q-2', text: 'Question 2?', why: 'The letter needs it.' },
  ]);
  expect(t.db.prepare("SELECT detail FROM application_events WHERE kind = 'status'").pluck().all()).toEqual(['{"step":"questions","status":"needs_answers","questions":2,"evidence":1}']);
  enqueue(t.db, 'career_letter', 'stray', { applicationId: t.id, attempt: 1 });
  await t.run();
  expect(t.cap.calls.filter((c) => c.pipeline === 'career-letter')).toHaveLength(0);
});

test.each([
  ['gaps', 'career-gaps'], ['ats', 'career-ats'], ['company', 'career-company'], ['vacancy', 'career-vacancy'], ['questions', 'career-questions'], ['letter', 'career-letter'],
])('a provider error at %s → failed/provider_error, without throwing', async (step, pipe) => {
  const t = pipeline({ by: { [pipe]: () => { throw new LlmError('overloaded', 'provider error 529', 529); } } });
  await t.run();
  expect(t.app()).toEqual({ status: 'failed', step, fail_code: 'provider_error' });
  expect(t.db.prepare("SELECT detail FROM application_events WHERE kind = 'failed'").pluck().all()).toEqual([JSON.stringify({ step, fail_code: 'provider_error' })]);
  expect(t.jobs().every((j) => j.status === 'done')).toBe(true);
});

test.each([
  ['a bullet under the wrong entry', () => ({ ...SELECTION, entries: [{ entry_id: K, bullet_ids: [`${N}-1a2b3c`] }] }), 'selection_invalid'],
  ['an unknown id', () => ({ ...SELECTION, skill_ids: ['skill-cobol'] }), 'selection_invalid'],
  ['an unknown requirement', () => ({ ...SELECTION, picks: [{ requirement_id: 'must-9', bullet_ids: ['sum-1'] }] }), 'selection_invalid'],
  ['an entry twice', () => ({ ...SELECTION, entries: [...SELECTION.entries, SELECTION.entries[0]] }), 'selection_invalid'],
  ['nothing selected', () => ({ picks: [], entries: [{ entry_id: N, bullet_ids: [] }], skill_ids: [] }), 'no_match'],
  ['a provider error', () => { throw new LlmError('overloaded', 'provider error 529', 529); }, 'provider_error'],
  ['an answer outside the schema', () => ({ picks: 'all' }), 'provider_error'],
])('match: %s → failed/%s, without throwing', async (_, match, code) => {
  const t = pipeline({ match }, config, 'match');
  await t.run();
  expect(t.app()).toEqual({ status: 'failed', step: 'match', fail_code: code });
  expect(t.jobs()).toEqual([{ key: `career:match:${t.id}:0`, status: 'done' }]);
  expect(t.db.prepare('SELECT detail FROM application_events').pluck().all()).toEqual([JSON.stringify({ step: 'match', fail_code: code })]);
});

test('draft: an answer outside the schema → provider_error; a missing master → failed/internal through the runner', async () => {
  const t = pipeline({ drafts: [() => ({ ...good(), entries: 'none' })] }, config, 'match');
  await t.run();
  expect(t.app()).toEqual({ status: 'failed', step: 'draft', fail_code: 'provider_error' });

  const u = pipeline({}, vault(['contact.md']), 'match');
  await u.run();
  expect(u.app()).toEqual({ status: 'failed', step: 'match', fail_code: 'internal' });
  expect(u.db.prepare('SELECT error FROM jobs').pluck().get()).toBe('Error'); // the type name only, never a path or text
});

test('a step job for an application that moved on does nothing', async () => {
  const t = pipeline({}, config, 'match');
  t.db.prepare(`UPDATE applications SET status = 'flagged', step = 'verify' WHERE id = ?`).run(t.id);
  enqueue(t.db, 'career_verify', 'v', { applicationId: t.id, attempt: 2 });
  await t.run();
  expect(t.cap.calls).toHaveLength(0);
  expect(t.app()).toEqual({ status: 'flagged', step: 'verify', fail_code: null });
  expect(t.db.prepare('SELECT count(*) FROM application_events').pluck().get()).toBe(0);
});

test('a retried run goes through every step again in the same application, with new job keys and text versions', async () => {
  const t = pipeline({ drafts: [() => { throw new LlmError('overloaded', 'provider error 529', 529); }, bad, good] });
  await t.run();
  expect(t.app()).toEqual({ status: 'failed', step: 'draft', fail_code: 'provider_error' });
  retryRun(t.db, t.id, 'h2');
  await t.run();
  expect(t.app()).toEqual({ status: 'draft_ready', step: 'letter_verify', fail_code: null });
  expect(t.keys()).toEqual([
    'career:intake:0', 'career:match:0', 'career:gaps:0', 'career:draft:1',
    'career:intake:1', 'career:match:0:1', 'career:gaps:0:1', 'career:draft:1:1', 'career:verify:1:1', 'career:draft:2:1', 'career:verify:2:1',
    ...FULL_RUN.slice(5).map((k) => `${k}:1`),
  ]);
  expect(t.texts('requirements')).toHaveLength(2);
  expect(t.texts('selection')).toHaveLength(2);
  expect(t.texts('gaps')).toHaveLength(2);
  expect(t.texts('draft')).toEqual([cvOnly(bad()), cvOnly(good()), withLetter(good())]);
});
