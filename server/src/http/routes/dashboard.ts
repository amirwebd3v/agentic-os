import { existsSync, readFileSync } from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import { parseMaster } from '../../career/master.ts';
import { providerStatus } from '../../llm/client.ts';
import { costOf } from '../../llm/prices.ts';
import { resolveNotePath, vaultGit } from '../../vault/writer.ts';

const DAYS = 30;
const STATUSES = ['processing', 'draft_ready', 'flagged', 'failed', 'final', 'applied', 'withdrawn'] as const;

/** YYYY-MM-DD of the user's local calendar day. */
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const round = (usd: number | null) => (usd === null ? null : Math.round(usd * 1e6) / 1e6);

interface Usage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost: number | null;
}
const empty = (): Usage => ({ calls: 0, input_tokens: 0, output_tokens: 0, cost: 0 });
const add = (u: Usage, input: number, output: number, cost: number | null) => {
  u.calls++;
  u.input_tokens += input;
  u.output_tokens += output;
  u.cost = u.cost === null || cost === null ? null : u.cost + cost; // one unpriced call makes the bucket "not priced"
};

/**
 * `GET /api/dashboard` (career-v2 §6, shape in career-contract.md §8.4): counts and aggregates only, never row text.
 * `vaultDir` overrides `config.vaultDir` (tests).
 */
export const dashboardRoutes =
  ({ vaultDir: vaultOverride }: { vaultDir?: string } = {}): FastifyPluginAsync =>
  async (api) => {
    const { db } = api;
    const vaultDir = vaultOverride ?? api.config.vaultDir;

    // ponytail: rows are read one by one so days follow the user's local time; fine for a personal app's 30 days
    const calls = db.prepare(
      `SELECT ts, pipeline, model, COALESCE(input_tokens, 0) input, COALESCE(output_tokens, 0) output, error IS NOT NULL failed
       FROM llm_calls WHERE ts >= ?`,
    );
    const count = (sql: string) => db.prepare(sql).pluck();
    const pendingApprovals = count(`SELECT COUNT(*) FROM approvals WHERE status = 'pending'`);
    const jobsBy = count(`SELECT COUNT(*) FROM jobs WHERE status = ?`);
    const jobsFailedSince = count(`SELECT COUNT(*) FROM jobs WHERE status = 'failed' AND created_at >= ?`);
    const notes = count(`SELECT COUNT(*) FROM vault_notes`);
    const byStatus = db.prepare(`SELECT status, COUNT(*) n FROM applications WHERE deleted_at IS NULL AND archived_at IS NULL GROUP BY status`);
    const archived = count(`SELECT COUNT(*) FROM applications WHERE deleted_at IS NULL AND archived_at IS NOT NULL`);
    const newSince = count(`SELECT COUNT(*) FROM applications WHERE deleted_at IS NULL AND created_at >= ?`);
    // Mirrors the web's nextStep() 'needs' group: a final run still rendering is in progress, and a due follow-up wins over "send it".
    const needsYou = count(
      `SELECT COUNT(*) FROM applications WHERE deleted_at IS NULL AND archived_at IS NULL AND (
         status IN ('failed', 'draft_ready', 'flagged')
         OR (status = 'final' AND step IS NOT 'render'
             AND (fail_code IS 'render_failed' OR follow_up_on IS NULL OR follow_up_on > ?)))`,
    );

    const lastCommit = async (): Promise<string | null> => {
      try {
        return (await vaultGit(vaultDir, 'log', '-1', '--format=%cI')).trim() || null;
      } catch {
        return null; // no vault, no git, no commits yet
      }
    };

    const master = () => {
      const abs = resolveNotePath(vaultDir, 'career/master.md');
      if (!existsSync(abs)) return { exists: false, entries: 0, lines: 0 };
      try {
        let entries = 0;
        let lines = 0;
        for (const s of parseMaster(readFileSync(abs, 'utf8')).sections) {
          if ('entries' in s) {
            entries += s.entries.length;
            for (const e of s.entries) lines += e.bullets.length;
          } else lines += s.bullets.length;
        }
        return { exists: true, entries, lines };
      } catch {
        return { exists: true, entries: null, lines: null }; // unparseable: the editor shows why
      }
    };

    api.get('/dashboard', async () => {
      const now = new Date();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (DAYS - 1));
      const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
      const monday = new Date(now);
      monday.setHours(0, 0, 0, 0);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));

      const days = new Map<string, Usage & { day: string; failures: number }>();
      for (let d = new Date(start); d <= now; d.setDate(d.getDate() + 1)) days.set(localDay(d), { day: localDay(d), ...empty(), failures: 0 });
      const pipelines = new Map<string, Usage>();
      const totals = { ...empty(), failures: 0 };
      let priced = true;
      for (const r of calls.all(start.toISOString()) as { ts: string; pipeline: string; model: string; input: number; output: number; failed: number }[]) {
        const cost = costOf(r.model, r.input, r.output);
        if (cost === null) priced = false;
        const day = days.get(localDay(new Date(r.ts)));
        if (day) {
          add(day, r.input, r.output, cost);
          day.failures += r.failed;
        }
        if (!pipelines.has(r.pipeline)) pipelines.set(r.pipeline, empty());
        add(pipelines.get(r.pipeline)!, r.input, r.output, cost);
        add(totals, r.input, r.output, cost);
        totals.failures += r.failed;
      }

      const by_status = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
      for (const { status, n } of byStatus.all() as { status: (typeof STATUSES)[number]; n: number }[]) by_status[status] = n;

      return {
        ai: {
          days: [...days.values()].map((d) => ({ ...d, cost: round(d.cost) })),
          by_pipeline: [...pipelines].map(([pipeline, u]) => ({ pipeline, ...u, cost: round(u.cost) })).sort((a, b) => b.calls - a.calls || a.pipeline.localeCompare(b.pipeline)),
          totals: { ...totals, cost: round(totals.cost) },
          priced,
        },
        system: {
          provider: providerStatus(api.config).status,
          approvals_pending: pendingApprovals.get() as number,
          jobs: {
            queued: jobsBy.get('queued') as number,
            running: jobsBy.get('running') as number,
            failed_7d: jobsFailedSince.get(weekAgo.toISOString()) as number,
          },
          vault_notes: notes.get() as number,
          last_vault_commit: await lastCommit(),
        },
        areas: {
          career: {
            by_status,
            archived: archived.get() as number,
            new_this_week: newSince.get(monday.toISOString()) as number,
            needs_you: needsYou.get(localDay(now)) as number,
            master: master(),
          },
          email: { connected: false },
          social: { connected: false },
        },
      };
    });
  };
