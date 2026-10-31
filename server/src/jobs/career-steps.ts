import { z } from 'zod';
import { atsCheck } from '../career/ats.ts';
import { loadContact } from '../career/contact.ts';
import type { Draft } from '../career/draft.ts';
import { analyseGaps } from '../career/gaps.ts';
import type { Requirements } from '../career/intake.ts';
import { askQuestions, companyBrief, letterSources, vacancyBrief, writeLetter } from '../career/letter.ts';
import type { Answers, AppContext, Company, Questions, Vacancy } from '../career/letter.ts';
import { atStep, enqueueStep, event, failStep, lastIds, latest, readMaster, saveText, setApp, TailorError } from '../career/tailor.ts';
import type { Step, Stop } from '../career/tailor.ts';
import type { VerifyReport } from '../career/verify.ts';
import { verifyDraft } from '../career/verify.ts';
import type { Database } from '../db/index.ts';
import { LlmError } from '../llm/errors.ts';
import type { CareerIntakeDeps } from './career-intake.ts';
import type { JobHandler } from './runner.ts';

// The steps after `match` (career-v2.md §3–§5): gaps → [draft → verify] → ats → company → vacancy → questions →
// [needs_answers] → letter → letter_verify. One attempt per job; an expected model failure is `failed/provider_error`.

const Payload = z.object({
  applicationId: z.number().int().positive(),
  attempt: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  stop: z.enum(['gaps', 'ats']).optional(),
});

/** The newest row of a kind with its version, or null. */
export function latestRow(db: Database, id: number, kind: string): { version: number; body: string } | null {
  return (db.prepare('SELECT version, body FROM application_texts WHERE application_id = ? AND kind = ? ORDER BY version DESC LIMIT 1').get(id, kind) as
    | { version: number; body: string }
    | undefined) ?? null;
}
const latestOrNull = <T>(db: Database, id: number, kind: string): T | null => {
  const row = latestRow(db, id, kind);
  return row ? (JSON.parse(row.body) as T) : null;
};
/** The posting's raw text (not JSON). */
export const postingOf = (db: Database, id: number): string => {
  const row = latestRow(db, id, 'posting');
  if (!row) throw new TailorError('step input missing');
  return row.body;
};
/** The owner's answers, only when they answer the current questions (a retried run asks again). */
export function currentAnswers(db: Database, id: number): Answers | null {
  const q = latestRow(db, id, 'questions');
  const a = latestOrNull<Answers & { questions_version: number }>(db, id, 'answers');
  return q && a && a.questions_version === q.version ? a : null;
}

type Ctx = { id: number; attempt: 0 | 1 | 2; stop: Stop | undefined; jobId: number; llmDeps: Parameters<typeof analyseGaps>[0] };

/**
 * A step's job: checks the payload and that the application still waits at `step`, then runs `body`. Inputs are read
 * outside `model()`, so a missing master or step input throws (→ `failed/internal` through the runner).
 */
const stepJob =
  (step: Step, body: (deps: CareerIntakeDeps, c: Ctx) => Promise<void>) =>
  (deps: CareerIntakeDeps): JobHandler =>
  async (job) => {
    const p = Payload.safeParse(job.payload);
    if (!p.success) throw new TailorError(`career_${step}: invalid payload`);
    const { applicationId: id, attempt, stop } = p.data;
    if (!atStep(deps.db, id, step)) return;
    const llmDeps = { db: deps.db, config: deps.config, contact: loadContact(deps.config.vaultDir), ...(deps.llm ? { llm: deps.llm } : {}) };
    await body(deps, { id, attempt, stop, jobId: job.id, llmDeps });
  };

/** The model call of a step; an expected failure marks the application `failed/provider_error` and gives null. */
async function model<T>(db: Database, id: number, step: Step, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof LlmError || err instanceof TailorError)) throw err;
    failStep(db, id, step, 'provider_error');
    return null;
  }
}

/** Stores a step's output, moves to `to` and queues it: one transaction. `detail`: counts only. */
function advance(db: Database, id: number, kind: string, value: unknown, from: Step, to: Step, attempt: 0 | 1 | 2, detail: Record<string, unknown> = {}, stop?: Stop): void {
  db.transaction(() => {
    saveText(db, id, kind, value);
    setApp(db, id, { step: to });
    event(db, id, 'step', { from, to, ...detail });
    enqueueStep(db, id, to, attempt, stop);
  })();
}

/**
 * The end of a partial run (#72, #73), instead of `advance`: stores the step's output and puts the application back
 * at rest. Pending questions (asked, not answered) → `needs_answers`; otherwise the latest verify report decides
 * `draft_ready` or `flagged` (a `final` application comes back as a draft: render again needs finalising again).
 */
function rest(db: Database, id: number, kind: string, value: unknown, from: Step, detail: Record<string, unknown>): void {
  db.transaction(() => {
    saveText(db, id, kind, value);
    const pending = !!latestOrNull<Questions>(db, id, 'questions')?.questions.length && !currentAnswers(db, id);
    const ok = latestOrNull<VerifyReport>(db, id, 'verify_report')?.ok ?? true;
    const to = pending
      ? { status: 'needs_answers', step: 'questions', fail_code: null }
      : { status: ok ? 'draft_ready' : 'flagged', step: 'letter_verify', fail_code: ok ? null : 'verify_failed' };
    setApp(db, id, to);
    event(db, id, 'status', { from, stopped: true, ...to, ...detail });
  })();
}

const verified = (points: { status: string }[]) => points.filter((p) => p.status === 'verified').length;

/** Job `career_gaps` (§3): master vs requirements, then the draft (attempt 1). */
export const careerGaps = stepJob('gaps', async ({ db, config }, { id, stop, jobId, llmDeps }) => {
  const req = latest<Requirements>(db, id, 'requirements');
  const master = readMaster(config.vaultDir);
  const gaps = await model(db, id, 'gaps', () => analyseGaps(llmDeps, master, req, jobId));
  if (!gaps) return;
  const counts = { keywords: gaps.missing_keywords.length, in_master: gaps.missing_keywords.filter((k) => k.in_master).length, suggestions: gaps.suggestions.length };
  if (stop === 'gaps') return rest(db, id, 'gaps', gaps, 'gaps', counts); // a re-read of the posting ends here
  advance(db, id, 'gaps', gaps, 'gaps', 'draft', 1, counts, stop);
});

/** Job `career_ats` (§4): the check once after verify, on the CV as drafted; then `company` (a CV refresh ends here). */
export const careerAts = stepJob('ats', async ({ db }, { id, stop, jobId, llmDeps }) => {
  const draft = latest<Draft>(db, id, 'draft');
  const req = latest<Requirements>(db, id, 'requirements');
  const report = await model(db, id, 'ats', () => atsCheck(llmDeps, draft, req, postingOf(db, id), jobId));
  if (!report) return;
  const counts = { score: report.score, findings: report.findings.length };
  if (stop === 'ats') return rest(db, id, 'ats', report, 'ats', counts);
  advance(db, id, 'ats', report, 'ats', 'company', 0, counts);
});

/** Job `career_company` (§5): from the pasted research and the posting only. */
export const careerCompany = stepJob('company', async ({ db }, { id, jobId, llmDeps }) => {
  const ctx = latestOrNull<AppContext>(db, id, 'context');
  const company = await model(db, id, 'company', () => companyBrief(llmDeps, postingOf(db, id), ctx, jobId));
  if (!company) return;
  advance(db, id, 'company', company, 'company', 'vacancy', 0, { research: company.has_research, points: company.points.length, verified: verified(company.points) });
});

/** Job `career_vacancy` (§5). */
export const careerVacancy = stepJob('vacancy', async ({ db }, { id, jobId, llmDeps }) => {
  const ctx = latestOrNull<AppContext>(db, id, 'context');
  const v = await model(db, id, 'vacancy', () => vacancyBrief(llmDeps, postingOf(db, id), ctx, jobId));
  if (!v) return;
  const all = [v.why_open, v.business_problem, ...v.outcomes, ...v.priorities];
  advance(db, id, 'vacancy', v, 'vacancy', 'questions', 0, { items: all.length, verified: verified(all) });
});

/** Job `career_questions` (§5): no questions → `letter`; otherwise the run pauses as `needs_answers`. */
export const careerQuestions = stepJob('questions', async ({ db, config }, { id, jobId, llmDeps }) => {
  const master = readMaster(config.vaultDir);
  const req = latest<Requirements>(db, id, 'requirements');
  const vacancy = latest<Vacancy>(db, id, 'vacancy');
  const company = latest<Company>(db, id, 'company');
  const q = await model(db, id, 'questions', () => askQuestions(llmDeps, master, req, vacancy, company, jobId));
  if (!q) return;
  const counts = { questions: q.questions.length, evidence: q.evidence.length };
  if (!q.questions.length) return advance(db, id, 'questions', q, 'questions', 'letter', 1, counts);
  db.transaction(() => {
    saveText(db, id, 'questions', q);
    setApp(db, id, { status: 'needs_answers' }); // step stays `questions`; POST …/answers resumes at `letter`
    event(db, id, 'status', { step: 'questions', status: 'needs_answers', ...counts });
  })();
});

/** Letter-related violations: a letter paragraph's id or `letter`. */
const letterOnly = (d: Draft, vs: VerifyReport['violations']) => {
  const ids = new Set(['letter', ...d.letter.paragraphs.map((p) => p.id)]);
  return vs.filter((v) => ids.has(v.ref));
};

/** Job `career_letter` (§5): writes the letter into a new draft version (origin `model`), then `letter_verify`. */
export const careerLetter = stepJob('letter', async ({ db, config }, { id, attempt, jobId, llmDeps }) => {
  if (attempt === 0) throw new TailorError('career_letter: invalid payload');
  const master = readMaster(config.vaultDir);
  const draft = latest<Draft>(db, id, 'draft');
  const inputs = {
    req: latest<Requirements>(db, id, 'requirements'),
    ctx: latestOrNull<AppContext>(db, id, 'context'),
    company: latest<Company>(db, id, 'company'),
    vacancy: latest<Vacancy>(db, id, 'vacancy'),
    questions: latest<Questions>(db, id, 'questions'),
    answers: currentAnswers(db, id),
  };
  const retry = attempt === 2 ? { letter: draft.letter.paragraphs, violations: letterOnly(draft, latest<VerifyReport>(db, id, 'verify_report').violations) } : undefined;
  const paragraphs = await model(db, id, 'letter', () => writeLetter(llmDeps, master, inputs, retry, jobId));
  if (!paragraphs) return;
  let { l } = lastIds(db, id, draft);
  const next: Draft = {
    ...draft,
    letter: { paragraphs: paragraphs.map((p) => ({ id: `l-${++l}`, ...p, origin: 'model' as const })) },
    versions: draft.versions + 1,
    // #72: what the letter rests on, for the stale check (the CV by the draft job that built it).
    built: { ...draft.built, letter: { posting: latestRow(db, id, 'posting')!.version, context: latestRow(db, id, 'context')?.version ?? 0, cv: draft.built?.cv?.job ?? 0 } },
  };
  advance(db, id, 'draft', next, 'letter', 'letter_verify', attempt, { attempt, paragraphs: paragraphs.length });
});

/** The whole draft, letter included, checked against the master as it is now; answers and company points are valid letter cites. */
export function wholeDraftReport(db: Database, id: number, draft: Draft, vaultDir: string): VerifyReport {
  const ctx = latestOrNull<AppContext>(db, id, 'context');
  const company = latestOrNull<Company>(db, id, 'company');
  return verifyDraft(draft, readMaster(vaultDir), latest<Requirements>(db, id, 'requirements'), loadContact(vaultDir), {
    sources: company ? letterSources(company, currentAnswers(db, id)) : new Map(),
    phrases: ctx?.company_name ? [ctx.company_name] : [],
  });
}

/**
 * Job `career_letter_verify` (§5): the whole draft, letter included, by plain code; answer and verified company
 * point ids are valid letter cites. Pass → `draft_ready`. Letter violations on attempt 1 → `letter` attempt 2.
 * Anything else (CV violations left from verify, or attempt 2) → `flagged/verify_failed`.
 */
export const careerLetterVerify = stepJob('letter_verify', async ({ db, config }, { id, attempt }) => {
  if (attempt === 0) throw new TailorError('career_letter_verify: invalid payload');
  const draft = latest<Draft>(db, id, 'draft');
  const report = wholeDraftReport(db, id, draft, config.vaultDir);
  const letter = letterOnly(draft, report.violations);
  const counts = { attempt, violations: report.violations.length, codes: [...new Set(report.violations.map((v) => v.code))] };
  db.transaction(() => {
    saveText(db, id, 'verify_report', report);
    if (report.ok) {
      setApp(db, id, { status: 'draft_ready' });
      event(db, id, 'status', { step: 'letter_verify', status: 'draft_ready', ...counts });
    } else if (attempt === 1 && letter.length) {
      setApp(db, id, { step: 'letter' });
      event(db, id, 'retry', { from: 'letter_verify', to: 'letter', ...counts });
      enqueueStep(db, id, 'letter', 2);
    } else {
      setApp(db, id, { status: 'flagged', fail_code: 'verify_failed' });
      event(db, id, 'status', { step: 'letter_verify', status: 'flagged', fail_code: 'verify_failed', ...counts });
    }
  })();
});
