import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { editDistance } from '../../approvals/edit-distance.ts';
import type { Requirements } from '../../career/intake.ts';
import { coverage, event, HEADER_FIELDS, readMaster, saveText } from '../../career/tailor.ts';
import type { Draft, DraftLine, MasterIndex, Selection } from '../../career/tailor.ts';
import { audit } from '../../db/audit.ts';
import type { Database } from '../../db/index.ts';
import { enqueue } from '../../db/jobs.ts';
import type { Job } from '../../db/jobs.ts';
import { FILE_KINDS, inside, outRoot } from '../../jobs/career-render.ts';
import { getLlm } from '../../llm/client.ts';
import { sha256 } from '../../vault/writer.ts';

export const MAX_POSTING_CHARS = 30_000;
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
  db.transaction(() => {
    db.prepare(`UPDATE applications SET status = 'processing', step = 'intake', fail_code = NULL, master_hash = ?, updated_at = ${NOW} WHERE id = ?`).run(masterHash, id);
    event(db, id, 'retry', { to: 'intake' });
    const n = db.prepare(`SELECT count(*) FROM jobs WHERE kind = 'career_intake' AND json_extract(payload, '$.applicationId') = ?`).pluck().get(id) as number;
    enqueue(db, 'career_intake', `career:intake:${id}:${n}`, { applicationId: id });
  })();
}

const ID_PARAMS = { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] } as const;
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type DraftEdit = { op?: 'set' | 'remove' | 'add' | 'restore'; ref: string; text?: string };
const INDEX = /^(?:0|[1-9]\d{0,3})$/;
const live = <T extends { removed?: true | undefined }>(x: T | null | undefined) => (x && !x.removed ? x : undefined);
const at = (list: DraftLine[], i: string | undefined) => (i !== undefined && INDEX.test(i) ? list[Number(i)] : undefined);
const lineAt = (list: DraftLine[], i: string | undefined) => live(at(list, i));

/**
 * Applies one edit to `d` in place (contract §8.2). Returns the ref it touched (for `add`, the new line's ref) and,
 * for a model line that was replaced or removed, its old text (for `edit_distance`); or a fixed error code.
 * Refs: `cv.summary`, `cv.entries[.<entry_id>[.<i> | .header.<field>]]`, `cv.skills`, `cv.languages`, `letter[.<i>]`.
 * A removed item stays in place with `removed: true`, so the refs after it keep their index, and `restore` brings it
 * back. `masterEntries` are the entry ids `add cv.entries` may take (text = the id).
 */
function applyEdit(d: Draft, { op = 'set', ref, text }: DraftEdit, masterEntries: readonly string[]): { ref: string; was?: string } | 'bad_ref' | 'bad_edit' {
  if ((op === 'remove' || op === 'restore') !== (text === undefined)) return 'bad_edit';
  const p = ref.split('.');
  const any = p[0] === 'cv' && p[1] === 'entries' ? d.entries.find((e) => e.entry_id === p[2]) : undefined;
  const entry = live(any);
  if (op === 'restore') {
    const item =
      ref === 'cv.summary' ? d.summary
      : any && p.length === 3 ? any
      : entry && p.length === 4 ? at(entry.bullets, p[3])
      : p[0] === 'letter' && p.length === 2 ? at(d.letter.paragraphs, p[1])
      : undefined;
    if (!item?.removed) return 'bad_ref';
    delete item.removed;
    return { ref };
  }
  if (ref === 'cv.summary' && op === 'add' && !live(d.summary)) {
    d.summary = { text: text!, cites: [] }; // replaces a removed model summary: the new line is yours
    return { ref };
  }
  if (ref === 'cv.entries' && op === 'add') {
    // An entry the draft has, even removed, keeps its ref: restore it instead of adding it twice.
    if (!masterEntries.includes(text!) || d.entries.some((e) => e.entry_id === text)) return 'bad_ref';
    d.entries.push({ entry_id: text!, bullets: [] });
    return { ref: `cv.entries.${text}` };
  }
  const line =
    ref === 'cv.summary' ? live(d.summary)
    : entry && p.length === 4 ? lineAt(entry.bullets, p[3])
    : p[0] === 'letter' && p.length === 2 ? lineAt(d.letter.paragraphs, p[1])
    : undefined;
  if (line && op !== 'add') {
    const was = line.text;
    if (op === 'set') line.text = text!; // cites unchanged; the line is yours now and not re-verified
    else line.removed = true;
    return { ref, was };
  }
  const list = entry && p.length === 3 ? entry.bullets : ref === 'letter' ? d.letter.paragraphs : undefined;
  if (list && op === 'add') return { ref: `${ref}.${list.push({ text: text!, cites: [] }) - 1}` };
  if (entry && p.length === 3 && op === 'remove') {
    entry.removed = true;
    return { ref };
  }
  const field = HEADER_FIELDS.find((f) => f === p[4]);
  if (entry && p.length === 5 && p[3] === 'header' && field && op !== 'add') {
    if ((text ?? '').length > 120) return 'bad_edit';
    entry.header = { ...entry.header, [field]: text ?? '' }; // remove = leave the field blank
    return { ref };
  }
  if ((ref === 'cv.skills' || ref === 'cv.languages') && op === 'set') {
    d[ref === 'cv.skills' ? 'skills_text' : 'languages_text'] = text!;
    return { ref };
  }
  return 'bad_ref';
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
  const lines = [draft.summary, ...draft.entries.flatMap((e) => e.bullets), ...draft.letter.paragraphs];
  const ids = [...draft.skill_ids, ...lines.flatMap((l) => l?.cites ?? []), ...draft.entries.map((e) => e.entry_id)];
  return Object.fromEntries(ids.filter((i) => all.has(i)).map((i) => [i, all.get(i)!]));
}

/** `ApplicationDetail` (contract §8.2), or null when there is no such application. */
function applicationDetail(db: Database, vaultDir: string, id: number) {
  const summary = db.prepare(`SELECT ${SUMMARY} FROM applications WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!summary) return null;
  const requirements = latest<Requirements>(db, id, 'requirements');
  const selection = latest<Selection>(db, id, 'selection');
  const draft = latest<Draft>(db, id, 'draft');
  const master = draft && masterOrNull(vaultDir);
  const languages = master?.sections.find((s) => s.name === 'Languages');
  const edited = db
    .prepare(`SELECT json_extract(detail, '$.refs') FROM application_events WHERE application_id = ? AND kind = 'edited'`)
    .pluck()
    .all(id) as string[];
  return {
    ...summary,
    requirements,
    coverage: requirements && selection ? coverage(requirements, selection) : null,
    draft,
    edited_refs: [...new Set(edited.flatMap((r) => (JSON.parse(r) as string[] | null) ?? []))],
    verify: latest(db, id, 'verify_report'),
    sources: master ? draftSources(master, draft) : {},
    master_entries: master ? masterEntries(master) : [], // what `add cv.entries` can take
    languages: languages && 'bullets' in languages ? languages.bullets.map((b) => b.text) : [],
    files: db.prepare('SELECT kind, bytes FROM application_files WHERE application_id = ? ORDER BY id').all(id),
    milestones: milestones(db, id),
  };
}

/**
 * Applications under `/api/career/applications` (career contract §8.2): start a run, list, detail, edit the draft,
 * finalise, render, download. `vaultDir` and `dataDir` override the config (tests).
 */
export const careerRoutes =
  ({ vaultDir: vaultOverride, dataDir: dataOverride }: { vaultDir?: string; dataDir?: string } = {}): FastifyPluginAsync =>
  async (api) => {
    const { db } = api;
    const vaultDir = vaultOverride ?? api.config.vaultDir;
    const masterPath = join(vaultDir, 'career', 'master.md');
    failStuckApplications(db); // boot: openDb's recoverStaleLocks fails a career job that was running at a crash
    type App = { status: string; step: string | null; master_hash: string };
    // A deleted application is gone for every route: 404, like an unknown id.
    const appRow = (id: number) => db.prepare('SELECT status, step, master_hash FROM applications WHERE id = ? AND deleted_at IS NULL').get(id) as App | undefined;
    /** A step runs: the pipeline, or a render (which completes only while the status is `final`). */
    const running = (a: App) => a.status === 'processing' || (a.status === 'final' && a.step === 'render');
    /** The master's hash for a new run, or the fixed code that refuses one. */
    const runHash = (): { hash: string } | { error: 'provider_not_configured' | 'master_missing' } => {
      if (!getLlm(api.config)) return { error: 'provider_not_configured' };
      try {
        return { hash: sha256(readFileSync(masterPath, 'utf8')) };
      } catch {
        return { error: 'master_missing' };
      }
    };

    api.post<{ Body: { posting: string } }>(
      '/career/applications',
      {
        schema: {
          body: {
            type: 'object',
            // No maxLength: too long is the fixed code `posting_too_long`, not Fastify's validation text.
            properties: { posting: { type: 'string', minLength: 1 } },
            required: ['posting'],
            additionalProperties: false,
          },
        },
      },
      async (req, reply) => {
        const { posting } = req.body;
        if (posting.length > MAX_POSTING_CHARS) return reply.code(400).send({ error: 'posting_too_long' });
        const run = runHash();
        if ('error' in run) return reply.code(409).send(run);
        const summary = db.transaction(() => {
          const row = db.prepare(`INSERT INTO applications (step, master_hash) VALUES ('intake', ?) RETURNING ${SUMMARY}`).get(run.hash) as { id: number };
          db.prepare(`INSERT INTO application_texts (application_id, kind, body) VALUES (?, 'posting', ?)`).run(row.id, posting);
          db.prepare(`INSERT INTO application_events (application_id, kind) VALUES (?, 'created')`).run(row.id);
          enqueue(db, 'career_intake', `career:intake:${row.id}:0`, { applicationId: row.id });
          return row;
        })();
        audit(db, { actor: 'user', action: 'career.application.create', args: { id: summary.id, chars: posting.length } });
        return reply.code(202).send(summary);
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

    // ---------- W2-08: edit the draft ----------
    api.patch<{ Params: { id: number }; Body: { edits: DraftEdit[] } }>(
      '/career/applications/:id/draft',
      {
        schema: {
          params: ID_PARAMS,
          body: {
            type: 'object',
            properties: {
              edits: {
                type: 'array',
                minItems: 1,
                maxItems: 50,
                items: {
                  type: 'object',
                  properties: {
                    op: { type: 'string', enum: ['set', 'remove', 'add', 'restore'] },
                    ref: { type: 'string', maxLength: 200 },
                    text: { type: 'string', minLength: 1, maxLength: 700 },
                  },
                  required: ['ref'],
                  additionalProperties: false,
                },
              },
            },
            required: ['edits'],
            additionalProperties: false,
          },
        },
      },
      async (req, reply) => {
        const { id } = req.params;
        const status = appRow(id)?.status;
        if (status === undefined) return reply.code(404).send({ error: 'not_found' });
        const draft = latest<Draft>(db, id, 'draft');
        if (!draft || (status !== 'draft_ready' && status !== 'flagged')) return reply.code(409).send({ error: 'wrong_status' });
        const master = req.body.edits.some((e) => e.ref === 'cv.entries') ? masterOrNull(vaultDir) : null;
        const entryIds = master ? masterEntries(master).map((e) => e.id) : [];
        const touched: string[] = [];
        const distances: number[] = [];
        for (const edit of req.body.edits) {
          const done = applyEdit(draft, edit, entryIds); // one bad edit rejects the batch: nothing is saved
          if (typeof done === 'string') return reply.code(400).send({ error: done });
          touched.push(done.ref);
          // ponytail: Levenshtein is O(n·m); the model's line is capped at 2000 chars for the metric only.
          if (done.was !== undefined) distances.push(edit.text === undefined ? 1 : editDistance(done.was.slice(0, 2000), edit.text));
        }
        draft.versions += 1;
        const refs = [...new Set(touched)];
        const edit_distance = distances.length ? distances.reduce((a, b) => a + b, 0) / distances.length : null;
        const counts = { lines: refs.length, edit_distance, version: draft.versions };
        db.transaction(() => {
          saveText(db, id, 'draft', draft);
          // Refs are ids and indexes (`cv.entries.<entry_id>.<i>`), never text: they make `edited_refs` real.
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
