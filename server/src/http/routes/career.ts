import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { Requirements } from '../../career/intake.ts';
import { coverage } from '../../career/tailor.ts';
import type { Selection } from '../../career/tailor.ts';
import { audit } from '../../db/audit.ts';
import type { Database } from '../../db/index.ts';
import { enqueue } from '../../db/jobs.ts';
import type { Job } from '../../db/jobs.ts';
import { getLlm } from '../../llm/client.ts';
import { sha256 } from '../../vault/writer.ts';

export const MAX_POSTING_CHARS = 30_000;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const SUMMARY = 'id, company, role_title, language, status, step, fail_code, follow_up_on, created_at, updated_at';

const CAREER_JOB = `kind LIKE 'career\\_%' ESCAPE '\\'`;

/** Sets `failed/internal` on the applications `where` selects, with an event and an audit row each. */
function markFailed(db: Database, where: string, ...params: unknown[]): void {
  const ids = db.transaction(() => {
    const ids = db
      .prepare(`UPDATE applications SET status = 'failed', fail_code = 'internal', updated_at = ${NOW} WHERE ${where} RETURNING id`)
      .pluck()
      .all(...params) as number[];
    const event = db.prepare(`INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'failed', '{"code":"internal"}')`);
    for (const id of ids) event.run(id);
    return ids;
  })();
  for (const id of ids) audit(db, { actor: 'app', action: 'career.application.fail', args: { id, code: 'internal' } });
}

/** The runner's `onFailed`: a career step that threw fails its application (a render throws after `final`). */
export function failCareerJob(db: Database, job: Job): void {
  if (!job.kind.startsWith('career_')) return;
  markFailed(db, `id = ? AND status IN ('processing', 'final')`, (job.payload as { applicationId: number }).applicationId);
}

/** Boot: a `processing` application with no career job left to run is stuck (e.g. its job was running at a crash). */
export function failStuckApplications(db: Database): void {
  markFailed(
    db,
    `status = 'processing' AND NOT EXISTS (SELECT 1 FROM jobs WHERE status IN ('queued', 'running') AND ${CAREER_JOB}
       AND json_extract(payload, '$.applicationId') = applications.id)`,
  );
}

/** Latest stored JSON output of a step, or null. */
function latest<T>(db: Database, id: number, kind: string): T | null {
  const body = db
    .prepare('SELECT body FROM application_texts WHERE application_id = ? AND kind = ? ORDER BY version DESC LIMIT 1')
    .pluck()
    .get(id, kind) as string | undefined;
  return body === undefined ? null : (JSON.parse(body) as T);
}

/**
 * Applications under `/api/career/applications` (career contract §8.2): start a run, list, detail.
 * `vaultDir` overrides `config.vaultDir` (tests).
 */
export const careerRoutes =
  ({ vaultDir: vaultOverride }: { vaultDir?: string } = {}): FastifyPluginAsync =>
  async (api) => {
    const { db } = api;
    const masterPath = join(vaultOverride ?? api.config.vaultDir, 'career', 'master.md');
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
      async (req, reply) => {
        const { id } = req.params;
        const summary = db.prepare(`SELECT ${SUMMARY} FROM applications WHERE id = ?`).get(id);
        if (!summary) return reply.code(404).send({ error: 'not_found' });
        const requirements = latest<Requirements>(db, id, 'requirements');
        const selection = latest<Selection>(db, id, 'selection');
        return {
          ...summary,
          requirements,
          coverage: requirements && selection ? coverage(requirements, selection) : null,
          draft: latest(db, id, 'draft'),
          // ponytail: edited_refs and sources stay empty until the edit route (W2-08) and the master parser (W2-04) land
          edited_refs: [],
          verify: latest(db, id, 'verify_report'),
          sources: {},
          files: db.prepare('SELECT kind, bytes FROM application_files WHERE application_id = ? ORDER BY id').all(id),
        };
      },
    );
  };
