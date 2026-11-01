import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { editDistance } from '../../approvals/edit-distance.ts';
import { draftLines, ORIGINS, SECTION_ORDER, toDraftV2 } from '../../career/draft.ts';
import type { CvEntry, CvLine, CvSection, Draft, Origin } from '../../career/draft.ts';
import type { Requirements } from '../../career/intake.ts';
import { BULLET_SECTIONS } from '../../career/master.ts';
import type { BulletSectionName, EntrySectionName } from '../../career/master.ts';
import { coverage, enqueueStep, event, lastIds, readMaster, saveText, setApp, TailorError } from '../../career/tailor.ts';
import type { DraftV1, MasterIndex, Selection, Stop } from '../../career/tailor.ts';
import { audit } from '../../db/audit.ts';
import type { Database } from '../../db/index.ts';
import { enqueue } from '../../db/jobs.ts';
import type { Job } from '../../db/jobs.ts';
import { FILE_KINDS, inside, outRoot } from '../../jobs/career-render.ts';
import { getLlm } from '../../llm/client.ts';
import type { structured } from '../../llm/client.ts';
import { LlmError } from '../../llm/errors.ts';
import { atsCheck } from '../../career/ats.ts';
import type { AtsReport } from '../../career/ats.ts';
import { loadContact } from '../../career/contact.ts';
import type { Gaps } from '../../career/gaps.ts';
import type { Answers, AppContext, Questions } from '../../career/letter.ts';
import { currentAnswers, latestRow, postingOf } from '../../jobs/career-steps.ts';
import { sha256 } from '../../vault/writer.ts';

export const MAX_POSTING_CHARS = 30_000;
export const MAX_RESEARCH_CHARS = 20_000;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const SUMMARY = 'id, company, role_title, language, status, step, fail_code, follow_up_on, archived_at, created_at, updated_at';

const CAREER_JOB = `kind LIKE 'career\\_%' ESCAPE '\\'`;

// `internal` fails the application. `render_failed` keeps it `final` and moves `step` off `render`, so the UI stops
// polling and `POST …/render` can retry (contract §7).
const FAIL = {
  internal: `status = 'failed', fail_code = 'internal'`,
  render_failed: `step = NULL, fail_code = 'render_failed'`,
} as const;

/** Applies `FAIL[code]` to the applications `where` selects, with an event and an audit row each. */
function markFailed(db: Database, code: keyof typeof FAIL, where: string, ...params: unknown[]): void {
  const ids = db.transaction(() => {
    const ids = db
      .prepare(`UPDATE applications SET ${FAIL[code]}, updated_at = ${NOW} WHERE ${where} RETURNING id`)
      .pluck()
      .all(...params) as number[];
    const event = db.prepare(`INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'failed', ?)`);
    for (const id of ids) event.run(id, JSON.stringify({ code }));
    return ids;
  })();
  for (const id of ids) audit(db, { actor: 'app', action: 'career.application.fail', args: { id, code } });
}

/** The runner's `onFailed`: a career step that threw fails its application; a render that threw is `render_failed`. */
export function failCareerJob(db: Database, job: Job): void {
  if (!job.kind.startsWith('career_')) return;
  const id = (job.payload as { applicationId: number }).applicationId;
  if (job.kind === 'career_render') markFailed(db, 'render_failed', `id = ? AND status = 'final' AND step = 'render'`, id);
  else markFailed(db, 'internal', `id = ? AND status = 'processing'`, id);
}

const NO_JOB_LEFT = `NOT EXISTS (SELECT 1 FROM jobs WHERE status IN ('queued', 'running') AND ${CAREER_JOB}
  AND json_extract(payload, '$.applicationId') = applications.id)`;

/** Boot: an application in a step with no career job left to run is stuck (e.g. its job was running at a crash). */
export function failStuckApplications(db: Database): void {
  markFailed(db, 'internal', `status = 'processing' AND ${NO_JOB_LEFT}`);
  markFailed(db, 'render_failed', `status = 'final' AND step = 'render' AND ${NO_JOB_LEFT}`);
}

/** Latest stored JSON output of a step, or null. */
function latest<T>(db: Database, id: number, kind: string): T | null {
  const body = db
    .prepare('SELECT body FROM application_texts WHERE application_id = ? AND kind = ? ORDER BY version DESC LIMIT 1')
    .pluck()
    .get(id, kind) as string | undefined;
  return body === undefined ? null : (JSON.parse(body) as T);
}

/** Queues a render; each one takes the next attempt number in its idempotency key (contract §4). */
function enqueueRender(db: Database, id: number): void {
  const n = db.prepare(`SELECT count(*) FROM jobs WHERE kind = 'career_render' AND json_extract(payload, '$.applicationId') = ?`).pluck().get(id) as number;
  enqueue(db, 'career_render', `career:render:${id}:${n}`, { applicationId: id });
}

/**
 * `POST …/retry`: a failed application runs the whole pipeline again from its stored posting, as a new run whose
 * intake key takes the next attempt number; the steps store new versions, and `latest()` reads the newest.
 */
export function retryRun(db: Database, id: number, masterHash: string): void {
  startRun(db, id, 'intake', { hash: masterHash });
}

/**
 * Starts a run at `from` (#72, #73): the whole pipeline (`intake` from a retry), a re-read (`intake`, `stop: 'gaps'`),
 * a CV refresh (`match`, `stop: 'ats'`) or a letter refresh (`company`, to the end). The first job's key takes the
 * next run number. `hash`: the master hash a run that rebuilds the CV records; null keeps the stored one.
 */
export function startRun(db: Database, id: number, from: 'intake' | 'match' | 'company', o: { hash?: string | null; stop?: Stop | undefined; detail?: Record<string, unknown> } = {}): void {
  db.transaction(() => {
    db.prepare(`UPDATE applications SET status = 'processing', step = ?, fail_code = NULL, master_hash = COALESCE(?, master_hash), updated_at = ${NOW} WHERE id = ?`).run(
      from,
      o.hash ?? null,
      id,
    );
    event(db, id, 'retry', { to: from, ...(o.stop && { stop: o.stop }), ...o.detail });
    if (from !== 'intake') return enqueueStep(db, id, from, 0, o.stop, true);
    const n = db.prepare(`SELECT count(*) FROM jobs WHERE kind = 'career_intake' AND json_extract(payload, '$.applicationId') = ?`).pluck().get(id) as number;
    enqueue(db, 'career_intake', `career:intake:${id}:${n}`, { applicationId: id, ...(o.stop && { stop: o.stop }) });
  })();
}

const ID_PARAMS = { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] } as const;
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

type LineIn = { id?: string; text: string; origin?: Origin; suggestion_id?: string };
type EntryIn = { id?: string; source?: string; org: string; title: string; start: string; end: string; location: string; bullets: LineIn[] };
type SectionIn = { name: string; bullets?: LineIn[]; entries?: EntryIn[] };
export type DraftPut = { versions: number; cv: { sections: SectionIn[] }; letter: { paragraphs: LineIn[] } };

/**
 * `PUT …/draft` (career-v2.md §1): the client's whole document over the stored one. The server owns ids, cites,
 * origin and an existing entry's `source`: a known id keeps its stored values; an unknown id or none is new and gets
 * the next server id, `cites: []` and `origin: 'owner'`; it is `'suggestion'` only when the client says so and names
 * in `suggestion_id` a gap suggestion that exists and is not dismissed (`suggestions`). A new entry keeps
 * the client's `source` only when it is a master entry id. `refs`: new lines and lines whose text changed.
 * `distances`: normalised Levenshtein of each changed model line, 1 for each removed one. Null: `bad_draft`.
 */
function putDraft(stored: Draft, body: DraftPut, masterEntryIds: ReadonlySet<string>, next: { l: number; e: number }, suggestions: ReadonlySet<string>) {
  const oldLines = new Map([...draftLines(stored)].map(({ line }) => [line.id, line]));
  const oldEntries = new Map(stored.cv.sections.flatMap((s) => ('entries' in s ? s.entries : [])).map((e) => [e.id, e]));
  const seen = new Set<string>();
  const refs: string[] = [];
  const distances: number[] = [];
  let bad = false;
  const once = (id: string | undefined) => {
    if (id !== undefined && seen.has(id)) bad = true;
    if (id !== undefined) seen.add(id);
  };
  const line = (l: LineIn): CvLine => {
    once(l.id);
    const text = l.text.trim();
    if (!text) bad = true;
    const old = l.id === undefined ? undefined : oldLines.get(l.id);
    if (!old) {
      const id = `l-${++next.l}`;
      refs.push(id);
      const s = l.origin === 'suggestion' && l.suggestion_id !== undefined && suggestions.has(l.suggestion_id) ? l.suggestion_id : undefined;
      return s === undefined ? { id, text, cites: [], origin: 'owner' } : { id, text, cites: [], origin: 'suggestion', suggestion_id: s };
    }
    if (old.text !== text) {
      refs.push(old.id);
      // ponytail: Levenshtein is O(n·m); the stored line is capped at 2000 chars for the metric only. Sample lines if saving a draft gets slow.
      if (old.origin === 'model') distances.push(editDistance(old.text.slice(0, 2000), text));
    }
    return { ...old, text };
  };
  const entry = (e: EntryIn): CvEntry => {
    once(e.id);
    const old = e.id === undefined ? undefined : oldEntries.get(e.id);
    const source = old ? old.source : e.source !== undefined && masterEntryIds.has(e.source) ? e.source : undefined;
    // A master entry keeps real dates; only the owner's own entry may leave them empty.
    if (source !== undefined && (!e.start || !e.end)) bad = true;
    const header = { org: e.org.trim(), title: e.title.trim(), start: e.start, end: e.end, location: e.location.trim() };
    return { id: old?.id ?? `e-${++next.e}`, ...(source === undefined ? {} : { source }), ...header, bullets: e.bullets.map(line) };
  };
  const names = new Set<string>();
  const sections: CvSection[] = [];
  for (const s of body.cv.sections) {
    const bulletSection = (BULLET_SECTIONS as readonly string[]).includes(s.name);
    if (names.has(s.name) || (bulletSection ? !s.bullets || s.entries : !s.entries || s.bullets)) return null;
    names.add(s.name);
    sections.push(bulletSection ? { name: s.name as BulletSectionName, bullets: s.bullets!.map(line) } : { name: s.name as EntrySectionName, entries: s.entries!.map(entry) });
  }
  const draft: Draft = {
    v: 2,
    cv: { sections },
    letter: { paragraphs: body.letter.paragraphs.map(line) },
    versions: stored.versions + 1,
    ...(stored.built && { built: stored.built }), // an owner's edit changes neither part's sources (#72)
  };
  if (bad) return null;
  for (const old of oldLines.values()) if (old.origin === 'model' && !seen.has(old.id)) distances.push(1);
  return { draft, refs, distances };
}

/** The master as it is now, or null when it is missing or invalid. */
function masterOrNull(vaultDir: string): MasterIndex['master'] | null {
  try {
    return readMaster(vaultDir).master;
  } catch {
    return null;
  }
}

/** Every master entry as `{ id, header }` (`org | title | start | end | location`), in master order. */
function masterEntries(master: MasterIndex['master']): { id: string; header: string }[] {
  return master.sections.flatMap((s) => ('entries' in s ? s.entries.map((e) => ({ id: e.id, header: [e.org, e.title, e.start, e.end, e.location].join(' | ') })) : []));
}

/**
 * The master text behind every id the draft cites or lists (bullet text without its entry header), plus each
 * entry's header (`org | title | start | end | location`) under its entry id so the page can title the CV sections.
 * An id the master no longer has is simply missing.
 */
function draftSources(master: MasterIndex['master'], draft: Draft): Record<string, string> {
  const all = new Map(masterEntries(master).map((e) => [e.id, e.header]));
  for (const s of master.sections) for (const b of 'bullets' in s ? s.bullets : s.entries.flatMap((e) => e.bullets)) all.set(b.id, b.text);
  const sourced = draft.cv.sections.flatMap((s) => ('entries' in s ? s.entries.flatMap((e) => (e.source === undefined ? [] : [e.source])) : []));
  const ids = [...[...draftLines(draft)].flatMap(({ line }) => line.cites), ...sourced];
  return Object.fromEntries(ids.filter((i) => all.has(i)).map((i) => [i, all.get(i)!]));
}

/** sha256 of `career/master.md`, or null when it is missing. */
function masterHash(vaultDir: string): string | null {
  try {
    return sha256(readFileSync(join(vaultDir, 'career', 'master.md'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * #72: why each part is out of date, or null. The CV: the posting or the master changed since it was built. The
 * letter: the posting, the company context or the CV (another draft job) changed since it was written. A draft from
 * before `built` was recorded was built from posting 1, context 1 (if any) and the run's master.
 */
function staleness(db: Database, id: number, draft: Draft, runHash: string, nowHash: string | null) {
  const v = (kind: string) => latestRow(db, id, kind)?.version ?? 0;
  const cv = draft.built?.cv ?? { posting: 1, master: runHash, job: 0 };
  const letter = draft.built?.letter ?? { posting: 1, context: Math.min(v('context'), 1), cv: 0 };
  return {
    cv: v('posting') !== cv.posting ? 'posting' : nowHash && nowHash !== cv.master ? 'master' : null,
    letter: !draft.letter.paragraphs.length
      ? null
      : v('posting') !== letter.posting
        ? 'posting'
        : v('context') !== letter.context
          ? 'context'
          : cv.job !== letter.cv
            ? 'cv'
            : null,
  };
}

/**
 * Where the running pipeline started and stops, so the page lists only those steps: the newest `startRun` event
 * (every run after the first starts there), else the create run, which goes from intake to the end.
 */
function currentRun(db: Database, id: number): { from: 'intake' | 'match' | 'company'; stop: Stop | null } {
  const ev = db
    .prepare(`SELECT detail FROM application_events WHERE application_id = ? AND kind = 'retry' AND json_extract(detail, '$.to') IN ('intake', 'match', 'company') ORDER BY id DESC LIMIT 1`)
    .pluck()
    .get(id) as string | undefined;
  const d = ev ? (JSON.parse(ev) as { to: 'intake' | 'match' | 'company'; stop?: Stop }) : null;
  return { from: d?.to ?? 'intake', stop: d?.stop ?? null };
}

/** `ApplicationDetail` (contract §8.2), or null when there is no such application. */
function applicationDetail(db: Database, vaultDir: string, id: number) {
  const summary = db.prepare(`SELECT ${SUMMARY}, master_hash FROM applications WHERE id = ? AND deleted_at IS NULL`).get(id) as { master_hash: string; status: string } | undefined;
  if (!summary) return null;
  const { master_hash: runHash, ...rest } = summary;
  const requirements = latest<Requirements>(db, id, 'requirements');
  const selection = latest<Selection>(db, id, 'selection');
  const raw = latest<Draft | DraftV1>(db, id, 'draft');
  const master = raw && masterOrNull(vaultDir);
  const draft = raw && toDraftV2(raw, master); // always v2; a v1 draft is written back as v2 on its next save
  const languages = master?.sections.find((s) => s.name === 'Languages');
  const edited = db
    .prepare(`SELECT json_extract(detail, '$.refs') FROM application_events WHERE application_id = ? AND kind = 'edited'`)
    .pluck()
    .all(id) as string[];
  return {
    ...rest,
    posting: latestRow(db, id, 'posting')?.body ?? null, // the owner's pasted text: rendered as text only
    stale: draft ? staleness(db, id, draft, runHash, masterHash(vaultDir)) : null,
    can_restore: draft?.built?.cv?.previous !== undefined, // a CV refresh can be undone (#73)
    run: rest.status === 'processing' ? currentRun(db, id) : null,
    requirements,
    coverage: requirements && selection ? coverage(requirements, selection) : null,
    draft,
    edited_refs: [...new Set(edited.flatMap((r) => (JSON.parse(r) as string[] | null) ?? []))],
    verify: latest(db, id, 'verify_report'),
    sources: master && draft ? draftSources(master, draft) : {},
    master_entries: master ? masterEntries(master) : [], // the entries a PUT may add with their `source`
    languages: languages && 'bullets' in languages ? languages.bullets.map((b) => b.text) : [],
    files: db.prepare('SELECT kind, bytes FROM application_files WHERE application_id = ? ORDER BY id').all(id),
    milestones: milestones(db, id),
    // career-v2.md §3–§5: model and owner text, rendered as text only.
    context: latest<AppContext>(db, id, 'context'),
    gaps: latest<Gaps>(db, id, 'gaps'),
    ats: atsDetail(db, id),
    company_brief: latest(db, id, 'company'), // kind `company`; `company` is the application's name column
    vacancy: latest(db, id, 'vacancy'),
    questions: latest<Questions>(db, id, 'questions'),
    answers: currentAnswers(db, id),
  };
}

/** The latest ATS report and the short history (newest first, at most 20), or null. */
function atsDetail(db: Database, id: number) {
  const rows = db.prepare("SELECT body FROM application_texts WHERE application_id = ? AND kind = 'ats' ORDER BY version DESC LIMIT 20").pluck().all(id) as string[];
  if (!rows.length) return null;
  const reports = rows.map((r) => JSON.parse(r) as AtsReport);
  return { ...reports[0]!, history: reports.map(({ score, draft_version, created_at }) => ({ score, draft_version, created_at })) };
}

/**
 * Applications under `/api/career/applications` (career contract §8.2): start a run, list, detail, edit the draft,
 * finalise, render, download. `vaultDir` and `dataDir` override the config (tests).
 */
export const careerRoutes =
  ({ vaultDir: vaultOverride, dataDir: dataOverride, llm }: { vaultDir?: string; dataDir?: string; llm?: typeof structured } = {}): FastifyPluginAsync =>
  async (api) => {
    const { db } = api;
    const vaultDir = vaultOverride ?? api.config.vaultDir;
    const masterPath = join(vaultDir, 'career', 'master.md');
    failStuckApplications(db); // boot: openDb's recoverStaleLocks fails a career job that was running at a crash
    type App = { status: string; step: string | null; master_hash: string; archived_at: string | null };
    // A deleted application is gone for every route: 404, like an unknown id.
    const appRow = (id: number) =>
      db.prepare('SELECT status, step, master_hash, archived_at FROM applications WHERE id = ? AND deleted_at IS NULL').get(id) as App | undefined;
    /** A step runs: the pipeline, or a render (which completes only while the status is `final`). */
    const running = (a: App) => a.status === 'processing' || (a.status === 'final' && a.step === 'render');
    /** #72/#73: the code that refuses a posting edit or a refresh, or null. Sent or withdrawn applications stay as sent. */
    const unrefreshable = (a: App) =>
      a.archived_at ? 'archived' : running(a) ? 'busy' : a.master_hash === '' || a.status === 'applied' || a.status === 'withdrawn' ? 'wrong_status' : null;
    /** The master's hash for a new run, or the fixed code that refuses one. */
    const runHash = (): { hash: string } | { error: 'provider_not_configured' | 'master_missing' } => {
      if (!llm && !getLlm(api.config)) return { error: 'provider_not_configured' };
      try {
        return { hash: sha256(readFileSync(masterPath, 'utf8')) };
      } catch {
        return { error: 'master_missing' };
      }
    };

    type CreateBody = { posting: string; company_name?: string; company_website?: string; research?: string; target_country?: string };
    const optional = (max: number) => ({ type: 'string', maxLength: max });
    const formBody = {
      type: 'object',
      // No maxLength on the posting and the research: too long is a fixed code, not Fastify's validation text.
      properties: {
        posting: { type: 'string', minLength: 1 },
        company_name: optional(200),
        company_website: optional(500),
        research: { type: 'string' },
        target_country: optional(100),
      },
      required: ['posting'],
      additionalProperties: false,
    };
    /** The form (create, and the posting edit of #72): the fixed code that refuses it, or its `context`. */
    const readForm = (b: CreateBody): { error: string } | { ctx: AppContext } => {
      if (b.posting.length > MAX_POSTING_CHARS) return { error: 'posting_too_long' };
      if ((b.research?.length ?? 0) > MAX_RESEARCH_CHARS) return { error: 'research_too_long' };
      // career-v2.md §5: the form beyond the posting, one `context` row. The website is text only, never fetched.
      const oneLine = (v: string | undefined) => v?.replace(/[\p{Cc}\s]+/gu, ' ').trim() || null;
      return {
        ctx: {
          company_name: oneLine(b.company_name),
          company_website: oneLine(b.company_website),
          target_country: oneLine(b.target_country),
          research: b.research?.replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\n\t]/gu, ' ').trim() || null,
        },
      };
    };
    /** Counts and which fields were given, never their values. */
    const formAudit = (ctx: AppContext) => {
      const given = (['company_name', 'company_website', 'target_country'] as const).filter((k) => ctx[k]);
      return ctx.research || given.length ? { research_chars: ctx.research?.length ?? 0, fields: given } : {};
    };
    api.post<{ Body: CreateBody }>('/career/applications', { schema: { body: formBody } }, async (req, reply) => {
        const { posting } = req.body;
        const form = readForm(req.body);
        if ('error' in form) return reply.code(400).send(form);
        const run = runHash();
        if ('error' in run) return reply.code(409).send(run);
        const { ctx } = form;
        const summary = db.transaction(() => {
          // The typed company name shows until intake reads the posting's.
          const row = db.prepare(`INSERT INTO applications (step, master_hash, company) VALUES ('intake', ?, ?) RETURNING ${SUMMARY}`).get(run.hash, ctx.company_name) as { id: number };
          db.prepare(`INSERT INTO application_texts (application_id, kind, body) VALUES (?, 'posting', ?)`).run(row.id, posting);
          if (Object.values(ctx).some((v) => v !== null)) saveText(db, row.id, 'context', ctx);
          db.prepare(`INSERT INTO application_events (application_id, kind) VALUES (?, 'created')`).run(row.id);
          enqueue(db, 'career_intake', `career:intake:${row.id}:0`, { applicationId: row.id });
          return row;
        })();
        audit(db, { actor: 'user', action: 'career.application.create', args: { id: summary.id, chars: posting.length, ...formAudit(ctx) } });
        return reply.code(202).send(summary);
    });

    // ---------- #72, #73: edit the posting, refresh a part, restore the CV ----------
    const EMPTY_CTX: AppContext = { company_name: null, company_website: null, target_country: null, research: null };
    api.put<{ Params: { id: number }; Body: CreateBody }>('/career/applications/:id/posting', { schema: { params: ID_PARAMS, body: formBody } }, async (req, reply) => {
      const { id } = req.params;
      const app = appRow(id);
      if (!app) return reply.code(404).send({ error: 'not_found' });
      const no = unrefreshable(app);
      if (no) return reply.code(409).send({ error: no });
      const form = readForm(req.body);
      if ('error' in form) return reply.code(400).send(form);
      const { ctx } = form;
      const { posting } = req.body;
      const ctxRow = latestRow(db, id, 'context');
      const newPosting = posting !== postingOf(db, id);
      const newCtx = JSON.stringify(ctx) !== JSON.stringify(ctxRow ? (JSON.parse(ctxRow.body) as AppContext) : EMPTY_CTX);
      if (!newPosting && !newCtx) return applicationDetail(db, vaultDir, id); // nothing changed: no new version, no run
      const run = newPosting ? runHash() : null;
      if (run && 'error' in run) return reply.code(409).send(run);
      db.transaction(() => {
        if (newCtx) saveText(db, id, 'context', ctx);
        // The posting is raw text, not JSON.
        if (newPosting)
          db.prepare(
            `INSERT INTO application_texts (application_id, kind, version, body)
             VALUES (?, 'posting', (SELECT MAX(version) + 1 FROM application_texts WHERE application_id = ? AND kind = 'posting'), ?)`,
          ).run(id, id, posting);
        const versions = { posting: latestRow(db, id, 'posting')!.version, context: latestRow(db, id, 'context')?.version ?? 0 };
        db.prepare(`INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'edited', ?)`).run(id, JSON.stringify({ ...versions, rerun: newPosting }));
        db.prepare(`UPDATE applications SET updated_at = ${NOW} WHERE id = ?`).run(id);
        // The re-read: intake → match → gaps, then back at rest. A failed application runs the whole pipeline (a retry).
        if (run) startRun(db, id, 'intake', app.status === 'failed' ? { hash: run.hash } : { stop: 'gaps', detail: { run: 'posting', from: app.status } });
      })();
      audit(db, { actor: 'user', action: 'career.application.posting_edit', args: { id, chars: posting.length, ...formAudit(ctx), rerun: newPosting } });
      return reply.code(newPosting ? 202 : 200).send(applicationDetail(db, vaultDir, id));
    });

    type Part = 'posting' | 'cv' | 'letter';
    const RUN_START = { posting: 'intake', cv: 'match', letter: 'company' } as const;
    const STOP = { posting: 'gaps', cv: 'ats', letter: undefined } as const;
    api.post<{ Params: { id: number }; Body: { part: Part } }>(
      '/career/applications/:id/refresh',
      {
        schema: {
          params: ID_PARAMS,
          body: { type: 'object', properties: { part: { enum: ['posting', 'cv', 'letter'] } }, required: ['part'], additionalProperties: false },
        },
      },
      async (req, reply) => {
        const { id } = req.params;
        const { part } = req.body;
        const app = appRow(id);
        if (!app) return reply.code(404).send({ error: 'not_found' });
        const no = unrefreshable(app);
        if (no) return reply.code(409).send({ error: no });
        // The CV starts at match (needs the requirements); the letter is written onto a draft.
        if ((part !== 'posting' && !latestRow(db, id, 'requirements')) || (part === 'letter' && !latestRow(db, id, 'draft'))) {
          return reply.code(409).send({ error: 'wrong_status' });
        }
        const run = runHash();
        if ('error' in run) return reply.code(409).send(run);
        // A failed application is not at rest: its refresh runs on to the end, like a retry from that step.
        const stop = app.status === 'failed' ? undefined : STOP[part];
        startRun(db, id, RUN_START[part], { hash: part === 'cv' ? run.hash : null, stop, detail: { run: part, from: app.status } });
        audit(db, { actor: 'user', action: 'career.application.refresh', args: { id, part } });
        return reply.code(202).send(applicationDetail(db, vaultDir, id));
      },
    );

    // Puts back the CV a refresh replaced, as a new version; the letter stays. Refused like a PUT of the draft.
    api.post<{ Params: { id: number }; Body: { versions: number } }>(
      '/career/applications/:id/draft/restore',
      {
        schema: {
          params: ID_PARAMS,
          body: { type: 'object', properties: { versions: { type: 'integer', minimum: 1 } }, required: ['versions'], additionalProperties: false },
        },
      },
      async (req, reply) => {
        const { id } = req.params;
        const app = appRow(id);
        if (!app) return reply.code(404).send({ error: 'not_found' });
        const no = unrefreshable(app);
        if (no) return reply.code(409).send({ error: no });
        const raw = latest<Draft | DraftV1>(db, id, 'draft');
        if (!raw || (app.status !== 'draft_ready' && app.status !== 'flagged')) return reply.code(409).send({ error: 'wrong_status' });
        const master = masterOrNull(vaultDir);
        const stored = toDraftV2(raw, master);
        if (req.body.versions !== stored.versions) return reply.code(409).send({ error: 'draft_changed' });
        const previous = stored.built?.cv?.previous;
        if (previous === undefined) return reply.code(409).send({ error: 'wrong_status' });
        const body = db.prepare(`SELECT body FROM application_texts WHERE application_id = ? AND kind = 'draft' AND version = ?`).pluck().get(id, previous) as string;
        const old = toDraftV2(JSON.parse(body) as Draft | DraftV1, master);
        const oldCv = old.built?.cv ?? { posting: 1, master: app.master_hash, job: 0 };
        const cvBuilt = { posting: oldCv.posting, master: oldCv.master, job: oldCv.job }; // one step back only: no `previous`
        const draft: Draft = {
          ...stored,
          cv: old.cv,
          versions: stored.versions + 1,
          built: { cv: cvBuilt, ...(stored.built?.letter && { letter: stored.built.letter }) },
        };
        db.transaction(() => {
          saveText(db, id, 'draft', draft);
          db.prepare(`INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'edited', ?)`).run(id, JSON.stringify({ restored: previous, version: draft.versions }));
          db.prepare(`UPDATE applications SET updated_at = ${NOW} WHERE id = ?`).run(id);
        })();
        audit(db, { actor: 'user', action: 'career.application.restore', args: { id, restored: previous, version: draft.versions } });
        return applicationDetail(db, vaultDir, id);
      },
    );

    api.get('/career/applications', async () =>
      db.prepare(`SELECT ${SUMMARY}, ${LIST_TRACKING} FROM applications WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 500`).all(),
    );

    api.get<{ Params: { id: number } }>(
      '/career/applications/:id',
      { schema: { params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] } } },
      async (req, reply) => applicationDetail(db, vaultDir, req.params.id) ?? reply.code(404).send({ error: 'not_found' }),
    );

    // ---------- career v2 §1: edit the draft (the whole document) ----------
    // Single-line text: no control characters. Header fields as the master's (no `|`); dates its grammar or empty.
    const text = (max: number, header = false) => ({ type: 'string', maxLength: max, pattern: header ? '^[^\\x00-\\x1f\\x7f|]*$' : '^[^\\x00-\\x1f\\x7f]*$' });
    const START = '^(?:\\d{4}(?:-(?:0[1-9]|1[0-2]))?)?$';
    const END ='^(?:\\d{4}(?:-(?:0[1-9]|1[0-2]))?|present)?$';
    const LINE = {
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 64 },
        text: { ...text(2000), minLength: 1 },
        cites: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } },
        origin: { enum: ORIGINS },
        suggestion_id: { type: 'string', maxLength: 64 },
      },
      required: ['text'],
      additionalProperties: false,
    };
    const lines = (max: number) => ({ type: 'array', maxItems: max, items: LINE });
    const putBody = {
      type: 'object',
      properties: {
        versions: { type: 'integer', minimum: 1 },
        cv: {
          type: 'object',
          properties: {
            sections: {
              type: 'array',
              maxItems: 7,
              items: {
                type: 'object',
                properties: {
                  name: { enum: SECTION_ORDER },
                  bullets: lines(100),
                  entries: {
                    type: 'array',
                    maxItems: 30,
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', maxLength: 64 },
                        source: { type: 'string', maxLength: 64 },
                        org: text(120, true),
                        title: text(120, true),
                        start: { type: 'string', pattern: START },
                        end: { type: 'string', pattern: END },
                        location: text(120, true),
                        bullets: lines(40),
                      },
                      required: ['org', 'title', 'start', 'end', 'location', 'bullets'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['name'],
                additionalProperties: false,
              },
            },
          },
          required: ['sections'],
          additionalProperties: false,
        },
        letter: { type: 'object', properties: { paragraphs: lines(12) }, required: ['paragraphs'], additionalProperties: false },
      },
      required: ['versions', 'cv', 'letter'],
      additionalProperties: false,
    };

    api.put<{ Params: { id: number }; Body: DraftPut }>(
      '/career/applications/:id/draft',
      { schema: { params: ID_PARAMS, body: putBody }, attachValidation: true }, // a fixed code, not Fastify's validation text
      async (req, reply) => {
        if (req.validationError) return reply.code(400).send({ error: 'bad_draft' });
        const { id } = req.params;
        const status = appRow(id)?.status;
        if (status === undefined) return reply.code(404).send({ error: 'not_found' });
        const raw = latest<Draft | DraftV1>(db, id, 'draft');
        if (!raw || (status !== 'draft_ready' && status !== 'flagged')) return reply.code(409).send({ error: 'wrong_status' });
        const master = masterOrNull(vaultDir);
        const stored = toDraftV2(raw, master);
        if (req.body.versions !== stored.versions) return reply.code(409).send({ error: 'draft_changed' });
        const gaps = latest<Gaps>(db, id, 'gaps');
        const open = new Set((gaps?.suggestions ?? []).map((g) => g.id).filter((g) => !gaps!.dismissed.includes(g)));
        const done = putDraft(stored, req.body, new Set(master ? masterEntries(master).map((e) => e.id) : []), lastIds(db, id, stored), open);
        if (!done) return reply.code(400).send({ error: 'bad_draft' });
        const { draft, refs, distances } = done;
        const edit_distance = distances.length ? distances.reduce((a, b) => a + b, 0) / distances.length : null;
        const counts = { lines: refs.length, edit_distance, version: draft.versions };
        db.transaction(() => {
          saveText(db, id, 'draft', draft);
          // Refs are line ids (`l-7`), never text: they make `edited_refs` real.
          db.prepare(`INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'edited', ?)`).run(id, JSON.stringify({ ...counts, refs }));
          db.prepare(`UPDATE applications SET updated_at = ${NOW} WHERE id = ?`).run(id);
        })();
        audit(db, { actor: 'user', action: 'career.application.edit', args: { id, ...counts } });
        return applicationDetail(db, vaultDir, id);
      },
    );

    // ---------- W2-09: finalise, render, download ----------
    const outDir = outRoot(dataOverride ?? api.config.dataDir);

    api.post<{ Params: { id: number }; Body: { acknowledge_flagged?: unknown } | undefined }>(
      '/career/applications/:id/final',
      { schema: { params: ID_PARAMS } },
      async (req, reply) => {
        const { id } = req.params;
        const app = appRow(id);
        if (!app) return reply.code(404).send({ error: 'not_found' });
        const flagged = app.status === 'flagged';
        if (flagged && req.body?.acknowledge_flagged !== true) return reply.code(409).send({ error: 'flagged_not_acknowledged' });
        if (!flagged && app.status !== 'draft_ready') return reply.code(409).send({ error: 'wrong_status' });
        db.transaction(() => {
          db.prepare(`UPDATE applications SET status = 'final', step = 'render', fail_code = NULL, updated_at = ${NOW} WHERE id = ?`).run(id);
          db.prepare(`INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'final', ?)`).run(id, JSON.stringify({ flagged }));
          enqueueRender(db, id);
        })();
        audit(db, { actor: 'user', action: 'career.application.final', args: { id, flagged } });
        return reply.code(202).send(applicationDetail(db, vaultDir, id));
      },
    );

    api.post<{ Params: { id: number } }>('/career/applications/:id/render', { schema: { params: ID_PARAMS } }, async (req, reply) => {
      const { id } = req.params;
      const app = appRow(id);
      if (!app) return reply.code(404).send({ error: 'not_found' });
      if (app.status !== 'final' || app.step === 'render') return reply.code(409).send({ error: 'wrong_status' });
      db.transaction(() => {
        db.prepare(`UPDATE applications SET step = 'render', fail_code = NULL, updated_at = ${NOW} WHERE id = ?`).run(id);
        event(db, id, 'retry', { to: 'render' });
        enqueueRender(db, id);
      })();
      return reply.code(202).send(applicationDetail(db, vaultDir, id));
    });

    api.get<{ Params: { id: number; kind: string } }>(
      '/career/applications/:id/files/:kind',
      { schema: { params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 }, kind: { type: 'string' } }, required: ['id', 'kind'] } } },
      async (req, reply) => {
        const { id, kind } = req.params;
        // An unknown kind is a 404, like an unknown id (contract §10), not a schema 400.
        if (!(FILE_KINDS as readonly string[]).includes(kind) || !appRow(id)) return reply.code(404).send({ error: 'not_found' });
        const relpath = db.prepare('SELECT relpath FROM application_files WHERE application_id = ? AND kind = ?').pluck().get(id, kind) as string | undefined;
        let file: Buffer;
        try {
          if (relpath === undefined) throw new Error('not recorded');
          file = readFileSync(inside(outDir, relpath));
        } catch {
          return reply.code(409).send({ error: 'files_not_ready' });
        }
        audit(db, { actor: 'user', action: 'career.file.download', args: { id, kind } });
        const name = kind.replace('_', '.'); // cv.docx, letter.docx
        return reply
          .header('content-type', DOCX_TYPE)
          .header('content-disposition', `attachment; filename="application-${id}-${name}"`)
          .header('cache-control', 'no-store')
          .send(file);
      },
    );

    // ---------- tracking ----------
    const DATE = { type: 'string', maxLength: 10 } as const; // checked as a real date in the handler: `400 bad_date`
    const NOTE = { type: ['string', 'null'], maxLength: 2000 } as const;
    const MID_PARAMS = { type: 'object', properties: { id: { type: 'integer', minimum: 1 }, mid: { type: 'integer', minimum: 1 } }, required: ['id', 'mid'] } as const;
    type MilestoneBody = { kind?: MilestoneKind; on_date?: string; note?: string | null };
    const audited = (id: number, detail: object) => audit(db, { actor: 'user', action: 'career.application.track', args: { id, ...detail } });

    /** The `{ code, error }` that refuses a milestone write, or null when the application can be tracked. */
    const untrackable = (id: number) => {
      const app = appRow(id);
      if (!app) return { code: 404, error: 'not_found' };
      // A running render only completes while the status is `final`, so tracking waits for it.
      return TRACKED.includes(app.status) && app.step !== 'render' ? null : { code: 409, error: 'wrong_status' };
    };

    api.get<{ Params: { id: number } }>('/career/applications/:id/milestones', { schema: { params: ID_PARAMS } }, async (req, reply) =>
      appRow(req.params.id) ? milestones(db, req.params.id) : reply.code(404).send({ error: 'not_found' }),
    );

    api.post<{ Params: { id: number }; Body: { kind: MilestoneKind; on_date: string; note?: string | null } }>(
      '/career/applications/:id/milestones',
      {
        schema: {
          params: ID_PARAMS,
          body: { type: 'object', properties: { kind: { enum: MILESTONE_KINDS }, on_date: DATE, note: NOTE }, required: ['kind', 'on_date'], additionalProperties: false },
        },
      },
      async (req, reply) => {
        const { id } = req.params;
        const { kind, on_date, note } = req.body;
        const no = untrackable(id);
        if (no) return reply.code(no.code).send({ error: no.error });
        if (!isDate(db, on_date)) return reply.code(400).send({ error: 'bad_date' });
        const detail = db.transaction(() => {
          const mid = db
            .prepare('INSERT INTO application_milestones (application_id, kind, on_date, note) VALUES (?, ?, ?, ?) RETURNING id')
            .pluck()
            .get(id, kind, on_date, cleanNote(note)) as number;
          return track(db, id, 'add', { id: mid, kind, on_date });
        })();
        audited(id, detail);
        return reply.code(201).send(applicationDetail(db, vaultDir, id));
      },
    );

    api.patch<{ Params: { id: number; mid: number }; Body: MilestoneBody }>(
      '/career/applications/:id/milestones/:mid',
      {
        schema: {
          params: MID_PARAMS,
          body: { type: 'object', properties: { kind: { enum: MILESTONE_KINDS }, on_date: DATE, note: NOTE }, minProperties: 1, additionalProperties: false },
        },
      },
      async (req, reply) => {
        const { id, mid } = req.params;
        const no = untrackable(id);
        if (no) return reply.code(no.code).send({ error: no.error });
        const cur = db.prepare('SELECT kind, on_date, note FROM application_milestones WHERE id = ? AND application_id = ?').get(mid, id) as
          | { kind: MilestoneKind; on_date: string; note: string | null }
          | undefined;
        if (!cur) return reply.code(404).send({ error: 'not_found' });
        const b = req.body;
        const next = { kind: b.kind ?? cur.kind, on_date: b.on_date ?? cur.on_date, note: 'note' in b ? cleanNote(b.note) : cur.note };
        if (!isDate(db, next.on_date)) return reply.code(400).send({ error: 'bad_date' });
        const detail = db.transaction(() => {
          db.prepare(`UPDATE application_milestones SET kind = ?, on_date = ?, note = ?, updated_at = ${NOW} WHERE id = ?`).run(next.kind, next.on_date, next.note, mid);
          return track(db, id, 'edit', { id: mid, kind: next.kind, on_date: next.on_date });
        })();
        audited(id, detail);
        return applicationDetail(db, vaultDir, id);
      },
    );

    api.delete<{ Params: { id: number; mid: number } }>('/career/applications/:id/milestones/:mid', { schema: { params: MID_PARAMS } }, async (req, reply) => {
      const { id, mid } = req.params;
      const no = untrackable(id);
      if (no) return reply.code(no.code).send({ error: no.error });
      const cur = db.prepare('SELECT kind, on_date FROM application_milestones WHERE id = ? AND application_id = ?').get(mid, id) as
        | { kind: MilestoneKind; on_date: string }
        | undefined;
      if (!cur) return reply.code(404).send({ error: 'not_found' });
      const detail = db.transaction(() => {
        db.prepare('DELETE FROM application_milestones WHERE id = ?').run(mid);
        return track(db, id, 'delete', { id: mid, ...cur });
      })();
      audited(id, detail);
      return applicationDetail(db, vaultDir, id);
    });

    // Status moves happen through milestones; this sets the follow-up date and renames.
    type AppPatch = { follow_up_on?: string | null; company?: string; role_title?: string };
    const NAME = { type: 'string', pattern: '\\S', maxLength: 200 } as const;
    api.patch<{ Params: { id: number }; Body: AppPatch }>(
      '/career/applications/:id',
      {
        schema: {
          params: ID_PARAMS,
          body: {
            type: 'object',
            properties: { follow_up_on: { type: ['string', 'null'], maxLength: 10 }, company: NAME, role_title: NAME },
            minProperties: 1,
            additionalProperties: false,
          },
        },
      },
      async (req, reply) => {
        const { id } = req.params;
        const b = req.body;
        const app = appRow(id);
        if (!app) return reply.code(404).send({ error: 'not_found' });
        const dated = b.follow_up_on !== undefined;
        if (typeof b.follow_up_on === 'string' && !isDate(db, b.follow_up_on)) return reply.code(400).send({ error: 'bad_date' });
        const fields = (['company', 'role_title'] as const).filter((k) => b[k] !== undefined);
        // Intake writes both names from the posting, so a rename waits for it.
        if (fields.length && app.status === 'processing') return reply.code(409).send({ error: 'wrong_status' });
        const cols: Record<string, string | null> = dated ? { follow_up_on: b.follow_up_on ?? null } : {};
        for (const k of fields) cols[k] = b[k]!.trim();
        db.transaction(() => {
          db.prepare(`UPDATE applications SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')}, updated_at = ${NOW} WHERE id = ?`).run(...Object.values(cols), id);
          if (fields.length) db.prepare(`INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'edited', ?)`).run(id, JSON.stringify({ fields }));
        })();
        if (dated) audit(db, { actor: 'user', action: 'career.application.follow_up', args: { id, follow_up_on: b.follow_up_on } });
        if (fields.length) audit(db, { actor: 'user', action: 'career.application.rename', args: { id, fields } }); // field names, never the values
        return applicationDetail(db, vaultDir, id);
      },
    );

    // ---------- career v2 §3–§5: gaps, ATS, answers ----------
    api.patch<{ Params: { id: number }; Body: { dismissed: string[] } }>(
      '/career/applications/:id/gaps',
      {
        schema: {
          params: ID_PARAMS,
          body: {
            type: 'object',
            properties: { dismissed: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 16 } } },
            required: ['dismissed'],
            additionalProperties: false,
          },
        },
      },
      async (req, reply) => {
        const { id } = req.params;
        if (!appRow(id)) return reply.code(404).send({ error: 'not_found' });
        const gaps = latest<Gaps>(db, id, 'gaps');
        if (!gaps) return reply.code(409).send({ error: 'wrong_status' });
        const ids = new Set(gaps.suggestions.map((g) => g.id));
        const dismissed = [...new Set(req.body.dismissed)];
        if (!dismissed.every((d) => ids.has(d))) return reply.code(400).send({ error: 'unknown_suggestion' });
        db.transaction(() => {
          saveText(db, id, 'gaps', { ...gaps, dismissed }); // the whole set: an id left out is shown again
          db.prepare(`INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'edited', ?)`).run(id, JSON.stringify({ dismissed }));
        })();
        audit(db, { actor: 'user', action: 'career.application.gaps', args: { id, dismissed: dismissed.length } });
        return applicationDetail(db, vaultDir, id);
      },
    );

    // Runs in the request (one model call) on the current draft version; the pipeline runs it once after verify.
    const ATS_STATUSES = ['draft_ready', 'flagged', 'needs_answers', 'final'];
    api.post<{ Params: { id: number } }>('/career/applications/:id/ats', { schema: { params: ID_PARAMS } }, async (req, reply) => {
      const { id } = req.params;
      const app = appRow(id);
      if (!app) return reply.code(404).send({ error: 'not_found' });
      const raw = latest<Draft | DraftV1>(db, id, 'draft');
      const requirements = latest<Requirements>(db, id, 'requirements');
      if (!raw || !requirements || !ATS_STATUSES.includes(app.status) || app.step === 'render') return reply.code(409).send({ error: 'wrong_status' });
      if (!llm && !getLlm(api.config)) return reply.code(409).send({ error: 'provider_not_configured' });
      const draft = toDraftV2(raw, masterOrNull(vaultDir));
      let report: AtsReport;
      try {
        const deps = { db, config: api.config, contact: loadContact(vaultDir), ...(llm ? { llm } : {}) };
        report = await atsCheck(deps, draft, requirements, postingOf(db, id));
      } catch (err) {
        if (!(err instanceof LlmError || err instanceof TailorError)) throw err;
        audit(db, { actor: 'user', action: 'career.application.ats', args: { id, error: 'provider_error' } });
        return reply.code(502).send({ error: 'provider_error' });
      }
      if (!appRow(id)) return reply.code(404).send({ error: 'not_found' }); // deleted during the call: store nothing
      saveText(db, id, 'ats', report);
      audit(db, { actor: 'user', action: 'career.application.ats', args: { id, score: report.score, draft_version: report.draft_version } });
      return applicationDetail(db, vaultDir, id);
    });

    type AnswersBody = { answers: { id: string; text: string | null }[] };
    api.post<{ Params: { id: number }; Body: AnswersBody }>(
      '/career/applications/:id/answers',
      {
        schema: {
          params: ID_PARAMS,
          body: {
            type: 'object',
            properties: {
              answers: {
                type: 'array',
                maxItems: 5,
                items: {
                  type: 'object',
                  properties: { id: { type: 'string', maxLength: 16 }, text: { type: ['string', 'null'], maxLength: 2000 } },
                  required: ['id', 'text'],
                  additionalProperties: false,
                },
              },
            },
            required: ['answers'],
            additionalProperties: false,
          },
        },
      },
      async (req, reply) => {
        const { id } = req.params;
        const app = appRow(id);
        if (!app) return reply.code(404).send({ error: 'not_found' });
        const q = latestRow(db, id, 'questions');
        if (app.status !== 'needs_answers' || !q) return reply.code(409).send({ error: 'wrong_status' });
        const questions = (JSON.parse(q.body) as Questions).questions;
        const given = new Map(req.body.answers.map((a) => [a.id, a.text]));
        if (given.size !== req.body.answers.length || ![...given.keys()].every((k) => questions.some((x) => x.id === k))) {
          return reply.code(400).send({ error: 'bad_answers' });
        }
        // A question left out is skipped, as `null` is. `a-<n>` answers `q-<n>`; control characters but line breaks go.
        const answers: Answers['answers'] = questions.map((x) => ({
          id: x.id.replace(/^q-/, 'a-'),
          question_id: x.id,
          text:
            given
              .get(x.id)
              ?.replace(/\r\n?/g, '\n')
              .replace(/[^\P{Cc}\n]/gu, ' ')
              .trim() || null,
        }));
        const answered = answers.filter((a) => a.text).length;
        db.transaction(() => {
          saveText(db, id, 'answers', { answers, questions_version: q.version });
          setApp(db, id, { status: 'processing', step: 'letter' });
          event(db, id, 'step', { from: 'questions', to: 'letter', answered, skipped: answers.length - answered });
          enqueueStep(db, id, 'letter', 1);
        })();
        audit(db, { actor: 'user', action: 'career.application.answers', args: { id, answered, skipped: answers.length - answered } });
        return reply.code(202).send(applicationDetail(db, vaultDir, id));
      },
    );

    // ---------- admin: retry, archive, delete ----------
    api.post<{ Params: { id: number } }>('/career/applications/:id/retry', { schema: { params: ID_PARAMS } }, async (req, reply) => {
      const { id } = req.params;
      const app = appRow(id);
      if (!app) return reply.code(404).send({ error: 'not_found' });
      // An application sent elsewhere (`master_hash = ''`) has no posting to run again.
      if (app.status !== 'failed' || app.master_hash === '') return reply.code(409).send({ error: 'wrong_status' });
      const run = runHash();
      if ('error' in run) return reply.code(409).send(run);
      retryRun(db, id, run.hash);
      audit(db, { actor: 'user', action: 'career.application.retry', args: { id } });
      return reply.code(202).send(applicationDetail(db, vaultDir, id));
    });

    api.post<{ Params: { id: number }; Body: { archived: boolean } }>(
      '/career/applications/:id/archive',
      {
        schema: {
          params: ID_PARAMS,
          body: { type: 'object', properties: { archived: { type: 'boolean' } }, required: ['archived'], additionalProperties: false },
        },
      },
      async (req, reply) => {
        const { id } = req.params;
        const { archived } = req.body;
        const app = appRow(id);
        if (!app) return reply.code(404).send({ error: 'not_found' });
        if (running(app)) return reply.code(409).send({ error: 'wrong_status' });
        db.transaction(() => {
          db.prepare(`UPDATE applications SET archived_at = ${archived ? `COALESCE(archived_at, ${NOW})` : 'NULL'}, updated_at = ${NOW} WHERE id = ?`).run(id);
          db.prepare(`INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'status', ?)`).run(id, JSON.stringify({ archived }));
        })();
        audit(db, { actor: 'user', action: 'career.application.archive', args: { id, archived } });
        return applicationDetail(db, vaultDir, id);
      },
    );

    // Permanent: the texts, milestones, files and names go; the row and its events stay (events are append-only).
    api.delete<{ Params: { id: number } }>('/career/applications/:id', { schema: { params: ID_PARAMS } }, async (req, reply) => {
      const { id } = req.params;
      const app = appRow(id);
      if (!app) return reply.code(404).send({ error: 'not_found' });
      if (running(app)) return reply.code(409).send({ error: 'wrong_status' });
      const counts = db.transaction(() => {
        const del = (table: string) => db.prepare(`DELETE FROM ${table} WHERE application_id = ?`).run(id).changes;
        const counts = { texts: del('application_texts'), milestones: del('application_milestones'), files: del('application_files') };
        db.prepare(`UPDATE applications SET company = NULL, role_title = NULL, follow_up_on = NULL, deleted_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`).run(id);
        db.prepare(`INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'status', '{"deleted":true}')`).run(id);
        // Nothing may run on it any more: a queued step would find no texts.
        db.prepare(`UPDATE jobs SET status = 'failed', error = 'application deleted' WHERE status = 'queued' AND ${CAREER_JOB} AND json_extract(payload, '$.applicationId') = ?`).run(id);
        return counts;
      })();
      rmSync(inside(outDir, String(id)), { recursive: true, force: true }); // after the commit; a missing folder is fine
      audit(db, { actor: 'user', action: 'career.application.delete', args: { id, ...counts } });
      return reply.code(204).send();
    });

    // A job applied to outside the app: no posting and no draft, only its tracking.
    api.post<{ Body: { company: string; role_title: string; applied_on: string } }>(
      '/career/applications/manual',
      {
        schema: {
          body: {
            type: 'object',
            properties: { company: { type: 'string', pattern: '\\S', maxLength: 200 }, role_title: { type: 'string', pattern: '\\S', maxLength: 200 }, applied_on: DATE },
            required: ['company', 'role_title', 'applied_on'],
            additionalProperties: false,
          },
        },
      },
      async (req, reply) => {
        const { company, role_title, applied_on } = req.body;
        if (!isDate(db, applied_on)) return reply.code(400).send({ error: 'bad_date' });
        const { summary, detail } = db.transaction(() => {
          const summary = db
            .prepare(`INSERT INTO applications (company, role_title, status, master_hash) VALUES (?, ?, 'applied', '') RETURNING ${SUMMARY}`)
            .get(company.trim(), role_title.trim()) as { id: number };
          db.prepare(`INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'created', '{"manual":true}')`).run(summary.id);
          const mid = db
            .prepare(`INSERT INTO application_milestones (application_id, kind, on_date) VALUES (?, 'applied', ?) RETURNING id`)
            .pluck()
            .get(summary.id, applied_on) as number;
          return { summary, detail: track(db, summary.id, 'add', { id: mid, kind: 'applied', on_date: applied_on }) };
        })();
        audit(db, { actor: 'user', action: 'career.application.create', args: { id: summary.id, manual: true } });
        audited(summary.id, detail);
        return reply.code(201).send(summary);
      },
    );
  };

// ---------- tracking (helpers) ----------
// Milestones are the owner's dated notes on an application (contract §5). `note` is personal free text: it is
// stored and returned to the owner, but never put in an event, the audit log, an error or a log line.
const MILESTONE_KINDS = ['applied', 'feedback', 'interview', 'offer', 'rejected', 'withdrawn', 'note'] as const;
type MilestoneKind = (typeof MILESTONE_KINDS)[number];
/** The statuses milestones may change; the pipeline's own states are left alone. */
const TRACKED = ['final', 'applied', 'withdrawn'];

/** For the list: the latest milestone and the next interview (today counts). */
const LIST_TRACKING = `
  (SELECT kind FROM application_milestones m WHERE m.application_id = applications.id ORDER BY on_date DESC, id DESC LIMIT 1) AS last_milestone,
  (SELECT on_date FROM application_milestones m WHERE m.application_id = applications.id ORDER BY on_date DESC, id DESC LIMIT 1) AS last_milestone_on,
  (SELECT min(on_date) FROM application_milestones m WHERE m.application_id = applications.id AND kind = 'interview'
     AND on_date >= date('now', 'localtime')) AS next_interview`;

function milestones(db: Database, id: number) {
  return db.prepare('SELECT id, kind, on_date, note, created_at, updated_at FROM application_milestones WHERE application_id = ? ORDER BY on_date, id').all(id);
}

/** A real calendar date as `YYYY-MM-DD` (SQLite turns 2026-02-30 into 2026-03-02, so that one is refused). */
const isDate = (db: Database, s: string) => db.prepare('SELECT date(?) IS ?').pluck().get(s, s) === 1;

const cleanNote = (note: string | null | undefined) => note?.trim() || null;

/**
 * After a milestone write, inside its transaction: moves `applications.status` to the latest `applied` / `withdrawn`
 * milestone (by date, then id), or back to the base when there is none: `final`, or `applied` for an application sent
 * elsewhere (it has no draft to be final). Adds a `status` event with ids, kinds and dates only; returns its detail.
 */
function track(db: Database, id: number, op: 'add' | 'edit' | 'delete', m: { id: number; kind: MilestoneKind; on_date: string }) {
  const app = db.prepare('SELECT status, master_hash FROM applications WHERE id = ?').get(id) as { status: string; master_hash: string };
  const latest = db
    .prepare(`SELECT kind FROM application_milestones WHERE application_id = ? AND kind IN ('applied', 'withdrawn') ORDER BY on_date DESC, id DESC LIMIT 1`)
    .pluck()
    .get(id) as string | undefined;
  // ponytail: "sent elsewhere" is `master_hash = ''` (POST …/manual); a column if a third origin ever appears.
  const to = latest ?? (app.master_hash === '' ? 'applied' : 'final');
  db.prepare(`UPDATE applications SET status = ?, updated_at = ${NOW} WHERE id = ?`).run(to, id);
  const detail = { op, milestone: m.id, kind: m.kind, on_date: m.on_date, ...(to !== app.status && { from: app.status, to }) };
  db.prepare(`INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'status', ?)`).run(id, JSON.stringify(detail));
  return detail;
}
