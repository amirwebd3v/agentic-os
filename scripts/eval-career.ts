// `pnpm eval:career` (W2-10): the career steps on the owner's real postings (`dataDir/career/evals/postings/*.txt`) and
// the real master, called directly: no application row, no job. Costs real tokens. Don't create applications while it
// runs: the before/after row check would fail. Numbers go to the console and `eval_runs` (suite `career-tailor`); the
// drafts, the only file holding text, go to `dataDir/career/evals/runs/<stamp>/` for the owner to rate.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atsCheck, cvText } from '../server/src/career/ats.ts';
import { loadContact } from '../server/src/career/contact.ts';
import type { Draft } from '../server/src/career/draft.ts';
import { extractRequirements } from '../server/src/career/intake.ts';
import { askQuestions, companyBrief, letterSources, vacancyBrief, writeLetter } from '../server/src/career/letter.ts';
import { coverage, lastIds, readMaster, selectBullets, writeDraft } from '../server/src/career/tailor.ts';
import { verifyDraft } from '../server/src/career/verify.ts';
import type { VerifyReport } from '../server/src/career/verify.ts';
import { loadConfig } from '../server/src/config.ts';
import { openDb } from '../server/src/db/index.ts';
import { LlmError } from '../server/src/llm/errors.ts';
import { costOf } from '../server/src/llm/prices.ts';
import { getSecret } from '../server/src/secrets.ts';

const SUITE = 'career-tailor';
const UNSUPPORTED = new Set(['unsupported_number', 'unsupported_entity']);

if (!getSecret('anthropic')) throw new Error('No anthropic key: set ANTHROPIC_API_KEY in .env (or AOS_ENV_FILE).');
const config = loadConfig();
const db = openDb(join(config.dataDir, 'brain.db'));
const deps = { db, config, contact: loadContact(config.vaultDir) };
const master = readMaster(config.vaultDir);

const postingsDir = join(config.dataDir, 'career', 'evals', 'postings');
const outDir = join(config.dataDir, 'career', 'evals', 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(outDir, { recursive: true });

const rowCounts = () => db.prepare('SELECT (SELECT count(*) FROM applications) apps, (SELECT count(*) FROM jobs) jobs').get() as { apps: number; jobs: number };
const before = rowCounts();
const words = (s: string) => s.match(/\S+/g)?.length ?? 0;
const codes = (r: VerifyReport) => [...new Set(r.violations.map((v) => v.code))];

/** What the calls since `lastCall` used; the app's jobs always carry a job id, these never do. */
// ponytail: list price of input + output like the dashboard; `llm_calls` has no cache writes, so a cold cache costs more than this.
function usageSince(lastCall: number) {
  const rows = db.prepare(`SELECT model, input_tokens i, output_tokens o, cache_read_tokens c, error FROM llm_calls WHERE id > ? AND job_id IS NULL AND pipeline LIKE 'career-%'`).all(lastCall) as {
    model: string; i: number | null; o: number | null; c: number | null; error: string | null;
  }[];
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + f(r), 0);
  const priced = rows.map((r) => costOf(r.model, r.i ?? 0, r.o ?? 0));
  return {
    calls: rows.length,
    failed: rows.filter((r) => r.error).length,
    input_tokens: sum((r) => r.i ?? 0),
    output_tokens: sum((r) => r.o ?? 0),
    cache_read_tokens: sum((r) => r.c ?? 0),
    cost_usd: priced.includes(null) ? null : Math.round(priced.reduce<number>((n, c) => n + c!, 0) * 10_000) / 10_000,
  };
}
const lastCallId = () => db.prepare('SELECT COALESCE(MAX(id), 0) FROM llm_calls').pluck().get() as number;

function draftNote(d: Draft, cv: VerifyReport, whole: VerifyReport): string {
  const out = ['Rating: usable / needs edits / wrong', ''];
  for (const s of d.cv.sections) {
    out.push(`## ${s.name}`);
    if ('bullets' in s) out.push(...s.bullets.map((b) => `- ${b.text}`));
    else for (const e of s.entries) out.push(`### ${[e.org, e.title, e.start, e.end, e.location].filter(Boolean).join(' | ')}`, ...e.bullets.map((b) => `- ${b.text}`));
    out.push('');
  }
  out.push('## Letter', ...d.letter.paragraphs.flatMap((p) => [p.text, '']));
  out.push('## Checks', `CV after its retry: ${JSON.stringify(cv.violations)}`, `Whole draft at the end: ${JSON.stringify(whole.violations)}`, '');
  return out.join('\n');
}

/** One posting through the steps, in the job order: match → draft → verify (one retry) → ats ×2 → briefs → letter → verify (one retry). */
async function runCase(posting: string, stem: string) {
  const r: Record<string, unknown> = {};
  const req = await extractRequirements(deps, posting);
  r.injection_suspected = req.injection_suspected;
  const sel = await selectBullets(deps, master, req);
  if (typeof sel === 'string') return { ...r, failed: sel };
  r.must_have = coverage(req, sel);

  let draft = await writeDraft(deps, master, req, sel);
  let cv = verifyDraft(draft, master, req, deps.contact, { letter: false });
  const cvFirst = cv.violations.length;
  const cvRetried = !cv.ok;
  if (!cv.ok) {
    draft = await writeDraft(deps, master, req, sel, { draft, violations: cv.violations });
    cv = verifyDraft(draft, master, req, deps.contact, { letter: false });
  }
  const bullets = draft.cv.sections.flatMap((s) => ('entries' in s ? s.entries.flatMap((e) => e.bullets) : []));
  const summary = draft.cv.sections.find((s) => s.name === 'Summary');
  r.cv = {
    retried: cvRetried,
    violations_first: cvFirst,
    violations: cv.violations.length,
    unsupported: cv.violations.filter((v) => UNSUPPORTED.has(v.code)).length,
    codes: codes(cv),
    bullets: bullets.length,
    words: words(cvText(draft)),
    longest_bullet: Math.max(0, ...bullets.map((b) => b.text.length)),
    summary_chars: summary && 'bullets' in summary ? (summary.bullets[0]?.text.length ?? 0) : 0,
  };

  writeFileSync(join(outDir, `${stem}.md`), draftNote(draft, cv, cv)); // kept if a later step fails; replaced at the end

  const ats = [await atsCheck(deps, draft, req, posting), await atsCheck(deps, draft, req, posting)];
  r.ats = { scores: ats.map((a) => a.score), rubric: ats.map((a) => a.parts.slice(-4).reduce((n, p) => n + p.score, 0)) };

  const company = await companyBrief(deps, posting, null);
  const vacancy = await vacancyBrief(deps, posting, null);
  const questions = await askQuestions(deps, master, req, vacancy, company);
  const inputs = { req, ctx: null, company, vacancy, questions, answers: null }; // no answers: the owner's are not part of the baseline
  const opts = { sources: letterSources(company, null) };
  const withLetter = (paragraphs: { text: string; cites: string[] }[]): Draft => {
    let { l } = lastIds(db, -1, draft);
    return { ...draft, letter: { paragraphs: paragraphs.map((p) => ({ id: `l-${++l}`, ...p, origin: 'model' as const })) }, versions: draft.versions + 1 };
  };
  draft = withLetter(await writeLetter(deps, master, inputs));
  let whole = verifyDraft(draft, master, req, deps.contact, opts);
  const letterRefs = (d: Draft) => new Set(['letter', ...d.letter.paragraphs.map((p) => p.id)]);
  const letterViolations = (d: Draft, rep: VerifyReport) => rep.violations.filter((v) => letterRefs(d).has(v.ref));
  const firstLetter = letterViolations(draft, whole);
  if (firstLetter.length) {
    draft = withLetter(await writeLetter(deps, master, inputs, { letter: draft.letter.paragraphs, violations: firstLetter }));
    whole = verifyDraft(draft, master, req, deps.contact, opts);
  }
  const finalLetter = letterViolations(draft, whole);
  r.letter = {
    pass_first: !firstLetter.length,
    pass: !finalLetter.length,
    violations_first: firstLetter.length,
    violations: finalLetter.length,
    unsupported: finalLetter.filter((v) => UNSUPPORTED.has(v.code)).length,
    codes: [...new Set(finalLetter.map((v) => v.code))],
    words: draft.letter.paragraphs.reduce((n, p) => n + words(p.text), 0),
    paragraphs: draft.letter.paragraphs.length,
    questions_unanswered: questions.questions.length,
    company_points_verified: company.points.filter((p) => p.status === 'verified').length,
    company_points: company.points.length,
  };
  writeFileSync(join(outDir, `${stem}.md`), draftNote(draft, cv, whole));
  return r;
}

const files = readdirSync(postingsDir).filter((f) => f.endsWith('.txt')).sort();
if (!files.length) throw new Error('No postings in dataDir/career/evals/postings.');
const results: Record<string, unknown>[] = [];
for (const file of files) {
  const stem = file.replace(/\.txt$/, '');
  const posting = readFileSync(join(postingsDir, file), 'utf8');
  // Fingerprint only: the posting text stays in its file.
  const input = JSON.stringify({ file, sha256: createHash('sha256').update(posting).digest('hex') });
  db.prepare(
    `INSERT INTO eval_cases (suite, name, input, expected) VALUES (?, ?, ?, ?)
     ON CONFLICT (suite, name) DO UPDATE SET input = excluded.input, expected = excluded.expected`,
  ).run(SUITE, stem, input, '0 unsupported claims, letter verifier passes');
  const mark = lastCallId();
  const t0 = Date.now();
  let r: Record<string, unknown>;
  try {
    r = await runCase(posting, stem);
  } catch (err) {
    r = { failed: err instanceof LlmError ? err.kind : (err as Error).constructor.name }; // never the message: it can quote text
  }
  results.push({ case: stem, ...r, usage: usageSince(mark), ms: Date.now() - t0 });
  console.log(`posting ${results.length}/${files.length}:`, JSON.stringify({ ...results.at(-1), case: undefined }));
}

type Graded = { failed?: string; cv?: { unsupported: number }; letter?: { unsupported: number; pass: boolean }; usage: { cost_usd: number | null } };
const graded = results as unknown as Graded[];
const correct = graded.filter((r) => !r.failed && r.cv?.unsupported === 0 && r.letter?.unsupported === 0 && r.letter.pass).length;
const costs = graded.map((r) => r.usage.cost_usd);
db.prepare(`INSERT INTO eval_runs (suite, model, total, correct, escalated, results) VALUES (?, ?, ?, ?, 0, ?)`).run(SUITE, config.llm.models.work, results.length, correct, JSON.stringify(results));

const after = rowCounts();
console.log(`\n${correct}/${results.length} with 0 unsupported claims and the letter passing`);
console.log(`Cost (list price, input + output): ${costs.includes(null) ? 'not priced' : `$${costs.reduce<number>((n, c) => n + c!, 0).toFixed(4)} total`}`);
console.log(`Application rows ${before.apps} → ${after.apps}, jobs ${before.jobs} → ${after.jobs}`);
db.close();
console.log(`Drafts written to the evals/runs folder under dataDir: ${outDir}`);
if (after.apps !== before.apps || after.jobs !== before.jobs) throw new Error('The eval changed the applications or jobs table.');
if (graded.some((r) => r.failed)) process.exitCode = 1;
