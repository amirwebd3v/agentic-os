import { readFileSync } from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import { ApprovalError, decide } from '../../approvals/apply.ts';
import type { Decision } from '../../approvals/apply.ts';
import { expireStale } from '../../approvals/expire.ts';
import { gitCommit, resolveNotePath } from '../../vault/writer.ts';

/** Items shown per calendar day; the rest wait behind "show more" so the queue can't outgrow a review session. */
export const DAILY_CAP = 15;
const DAY_MS = 86_400_000;

interface PendingRow {
  id: number;
  action_type: string;
  payload: string;
  proposed_by: string;
  created_at: string;
  original_text: string | null;
}

const decisionSchema = { enum: ['approve', 'reject'] } as const;

/**
 * Review queue under `/api/approvals`. Registering it expires stale proposals and repeats that daily.
 * `vaultDir` overrides `config.vaultDir` (tests).
 */
export const approvalRoutes =
  ({ vaultDir: vaultOverride }: { vaultDir?: string } = {}): FastifyPluginAsync =>
  async (api) => {
    const { db } = api;
    const vaultDir = vaultOverride ?? api.config.vaultDir;

    const runExpiry = () => {
      try {
        expireStale(db);
      } catch (err) {
        api.log.error(err, 'approval expiry failed');
      }
    };
    runExpiry();
    const timer = setInterval(runExpiry, DAY_MS).unref();
    api.addHook('onClose', async () => clearInterval(timer));

    const pending = db.prepare(
      `SELECT id, action_type, payload, proposed_by, created_at, original_text FROM approvals
       WHERE status = 'pending' ORDER BY created_at, id LIMIT ?`,
    );
    const countPending = db.prepare(`SELECT COUNT(*) n FROM approvals WHERE status = 'pending'`).pluck();
    const decidedSince = db.prepare(`SELECT COUNT(*) n FROM approvals WHERE status IN ('approved', 'rejected') AND decided_at >= ?`).pluck();

    /** The user's current file, so the UI can diff it against the proposal. */
    const currentText = (path: unknown): string | null => {
      try {
        return readFileSync(resolveNotePath(vaultDir, String(path)), 'utf8');
      } catch {
        return null; // deleted, or a path the writer would refuse anyway
      }
    };

    api.get<{ Querystring: { status: 'pending'; all?: boolean } }>(
      '/approvals',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: { status: { const: 'pending' }, all: { type: 'boolean' } },
            additionalProperties: false,
          },
        },
      },
      async (req) => {
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0); // the user's calendar day, not UTC's
        // ponytail: "show more" is capped at 200; page it if the queue ever gets that long
        const limit = req.query.all ? 200 : Math.max(0, DAILY_CAP - (decidedSince.get(midnight.toISOString()) as number));
        const items = (pending.all(limit) as PendingRow[]).map(({ payload, ...r }) => {
          const p = JSON.parse(payload) as Record<string, unknown>;
          return { ...r, payload: p, ...(r.action_type === 'vault_conflict' && { current_text: currentText(p.path) }) };
        });
        const total = countPending.get() as number;
        return { items, more: total - items.length, total };
      },
    );

    const apply = (id: number, decision: Decision, finalText?: string) => {
      const result = decide(db, vaultDir, id, decision, finalText);
      if (result.wrote) {
        void gitCommit(vaultDir, `aos: approval ${id}\n\n${result.wrote}`).catch((err: unknown) =>
          api.log.warn(`vault commit failed: ${(err as Error).message}`),
        );
      }
      return result.status;
    };
    const errorOf = (err: unknown) => {
      if (err instanceof ApprovalError) return err;
      api.log.error(err, 'approval failed');
      return null;
    };

    api.post<{ Params: { id: number }; Body: { decision: Decision; final_text?: string } }>(
      '/approvals/:id/decide',
      {
        schema: {
          params: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] },
          body: {
            type: 'object',
            properties: { decision: decisionSchema, final_text: { type: 'string', minLength: 1, maxLength: 2000 } },
            required: ['decision'],
            additionalProperties: false,
          },
        },
      },
      async (req, reply) => {
        try {
          return { id: req.params.id, status: apply(req.params.id, req.body.decision, req.body.final_text) };
        } catch (err) {
          const known = errorOf(err);
          return known ? reply.code(known.status).send({ error: known.message }) : reply.code(500).send({ error: 'could not apply the decision' });
        }
      },
    );

    api.post<{ Body: { ids: number[]; decision: Decision } }>(
      '/approvals/batch',
      {
        schema: {
          body: {
            type: 'object',
            properties: {
              ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 100, uniqueItems: true },
              decision: decisionSchema,
            },
            required: ['ids', 'decision'],
            additionalProperties: false,
          },
        },
      },
      // Each item commits on its own: one stale conflict doesn't undo the others.
      async (req) =>
        req.body.ids.map((id) => {
          try {
            return { id, ok: true, status: apply(id, req.body.decision) };
          } catch (err) {
            return { id, ok: false, error: errorOf(err)?.message ?? 'could not apply the decision' };
          }
        }),
    );
  };
