import { readFileSync } from 'node:fs';
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
const SUMMARY = 'id, company, role_title, language, status, step, fail_code, follow_up_on, created_at, updated_at';

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

const ID_PARAMS = { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] } as const;
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type DraftEdit = { op?: 'set' | 'remove' | 'add'; ref: string; text?: string };
const INDEX = /^(?:0|[1-9]\d{0,3})$/;
const live = <T extends { removed?: true | undefined }>(x: T | null | undefined) => (x && !x.removed ? x : undefined);
const lineAt = (list: DraftLine[], i: string | undefined) => (i !== undefined && INDEX.test(i) ? live(list[Number(i)]) : undefined);

/**
 * Applies one edit to `d` in place (contract §8.2). Returns the ref it touched (for `add`, the new line's ref) and,
 * for a model line that was replaced or removed, its old text (for `edit_distance`); or a fixed error code.
 * Refs: `cv.summary`, `cv.entries.<entry_id>[.<i> | .header.<field>]`, `cv.skills`, `cv.languages`, `letter[.<i>]`.
 * A removed item stays in place with `removed: true`, so the refs after it keep their index.
 */
function applyEdit(d: Draft, { op = 'set', ref, text }: DraftEdit): { ref: string; was?: string } | 'bad_ref' | 'bad_edit' {
  if ((op === 'remove') !== (text === undefined)) return 'bad_edit';
  const p = ref.split('.');
  const entry = p[0] === 'cv' && p[1] === 'entries' ? live(d.entries.find((e) => e.entry_id === p[2])) : undefined;
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

/**
 * The master text behind every id the draft cites or lists (bullet text without its entry header), plus each
 * entry's header (`org | title | start | end | location`) under its entry id so the page can title the CV sections.
 * An id the master no longer has is simply missing.
 */
function draftSources(master: MasterIndex['master'], draft: Draft): Record<string, string> {
  const all = new Map<string, string>();
  for (const s of master.sections) {
    if ('bullets' in s) for (const b of s.bullets) all.set(b.id, b.text);
    else
      for (const e of s.entries) {
        all.set(e.id, [e.org, e.title, e.start, e.end, e.location].join(' | '));
        for (const b of e.bullets) all.set(b.id, b.text);
      }
  }
  const lines = [draft.summary, ...draft.entries.flatMap((e) => e.bullets), ...draft.letter.paragraphs];
  const ids = [...draft.skill_ids, ...lines.flatMap((l) => l?.cites ?? []), ...draft.entries.map((e) => e.entry_id)];
  return Object.fromEntries(ids.filter((i) => all.has(i)).map((i) => [i, all.get(i)!]));
}

/** `ApplicationDetail` (contract §8.2), or null when there is no such application. */
function applicationDetail(db: Database, vaultDir: string, id: number) {
  const summary = db.prepare(`SELECT ${SUMMARY} FROM applications WHERE id = ?`).get(id);
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
    languages: languages && 'bullets' in languages ? languages.bullets.map((b) => b.text) : [],
    files: db.prepare('SELECT kind, bytes FROM application_files WHERE application_id = ? ORDER BY id').all(id),
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
        if (!getLlm(api.config)) return reply.code(409).send({ error: 'provider_not_configured' });
        let master: string;
        try {
          master = readFileSync(masterPath, 'utf8');
        } catch {
          return reply.code(409).send({ error: 'master_missing' });
        }
        const summary = db.transaction(() => {
          const row = db
            .prepare(`INSERT INTO applications (step, master_hash) VALUES ('intake', ?) RETURNING ${SUMMARY}`)
            .get(sha256(master)) as { id: number };
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
      db.prepare(`SELECT ${SUMMARY} FROM applications ORDER BY created_at DESC, id DESC LIMIT 100`).all(),
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
                    op: { type: 'string', enum: ['set', 'remove', 'add'] },
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
        const status = db.prepare('SELECT status FROM applications WHERE id = ?').pluck().get(id) as string | undefined;
        if (status === undefined) return reply.code(404).send({ error: 'not_found' });
        const draft = latest<Draft>(db, id, 'draft');
        if (!draft || (status !== 'draft_ready' && status !== 'flagged')) return reply.code(409).send({ error: 'wrong_status' });
        const touched: string[] = [];
        const distances: number[] = [];
        for (const edit of req.body.edits) {
          const done = applyEdit(draft, edit); // one bad edit rejects the batch: nothing is saved
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
    const status = (id: number) => db.prepare('SELECT status, step FROM applications WHERE id = ?').get(id) as { status: string; step: string | null } | undefined;

    api.post<{ Params: { id: number }; Body: { acknowledge_flagged?: unknown } | undefined }>(
      '/career/applications/:id/final',
      { schema: { params: ID_PARAMS } },
      async (req, reply) => {
        const { id } = req.params;
        const app = status(id);
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
      const app = status(id);
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
        if (!(FILE_KINDS as readonly string[]).includes(kind) || !status(id)) return reply.code(404).send({ error: 'not_found' });
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
  };
