import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { dashboardRoutes } from '../src/http/routes/dashboard.ts';
import { costOf, priceKey } from '../src/llm/prices.ts';
import { gitCommit, vaultGit } from '../src/vault/writer.ts';
import { buildTestApp } from './helpers.ts';

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 10 }))));
const SECRET = 'Zyx-Personal-Text';

const MASTER = `---
id: career-master
area: career
tags: []
sensitivity: 2
source: hand
created: '2026-10-01T00:00:00.000Z'
updated: '2026-10-01T00:00:00.000Z'
---
## Summary
- Backend engineer.  ^sum-1

## Experience
### Acme GmbH | Senior Engineer | 2021-03 | 2024-06 | Berlin  ^exp-acme-2021
- Cut the build.  ^exp-acme-2021-3f9a1c
- Led a team.  ^exp-acme-2021-b27e04

### Beispiel AG |  | 2019 | present |   ^exp-beispiel-2019

## Skills
- Python  ^skill-python
`;

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

test('prices: normalised family + version, unknown is null', () => {
  expect(priceKey('claude-sonnet-5-5')).toBe('sonnet-5.5');
  expect(priceKey('anthropic/claude-opus-5.5')).toBe('opus-5.5');
  expect(priceKey('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('haiku-4.5');
  expect(priceKey('claude-sonnet-5-20260101')).toBe('sonnet-5');
  expect(priceKey('gpt-5')).toBeNull();
  expect(costOf('claude-opus-5-5[1m]', 1_000_000, 1_000_000)).toBe(24);
  expect(costOf('mystery-model', 10, 0)).toBeNull();
  expect(costOf('mystery-model', 0, 0)).toBe(0);
});

test('GET /api/dashboard: aggregates only, local days, unpriced buckets are null', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'aos-dash-'));
  dirs.push(vault);
  mkdirSync(join(vault, 'career'));
  writeFileSync(join(vault, 'career/master.md'), MASTER);
  const t = await buildTestApp({ loggedIn: true, plugins: [dashboardRoutes({ vaultDir: vault })] });
  const { db } = t;

  const call = db.prepare(`INSERT INTO llm_calls (ts, pipeline, model, input_tokens, output_tokens, error) VALUES (?, ?, ?, ?, ?, ?)`);
  call.run(daysAgo(0).toISOString(), 'career-draft', 'claude-sonnet-5-5', 1_000_000, 100_000, null); // $3
  call.run(daysAgo(0).toISOString(), 'career-draft', 'claude-sonnet-5-5', null, null, `rate_limit: ${SECRET}`); // failure, $0
  call.run(daysAgo(2).toISOString(), 'career-intake', 'claude-haiku-5-5', 2_000_000, 0, null); // $0.2
  call.run(daysAgo(5).toISOString(), 'career-match', 'some-router/unknown-model', 10, 10, null); // not priced
  call.run(daysAgo(40).toISOString(), 'career-draft', 'claude-opus-5-5', 5, 5, null); // outside the window

  const job = db.prepare(`INSERT INTO jobs (kind, idempotency_key, payload, status, created_at, error) VALUES ('k', ?, '{}', ?, ?, ?)`);
  job.run('a', 'queued', daysAgo(0).toISOString(), null);
  job.run('b', 'running', daysAgo(0).toISOString(), null);
  job.run('c', 'failed', daysAgo(1).toISOString(), SECRET);
  job.run('d', 'failed', daysAgo(10).toISOString(), SECRET);
  job.run('e', 'done', daysAgo(0).toISOString(), null);
  const approval = db.prepare(`INSERT INTO approvals (action_type, payload, proposed_by, status) VALUES ('x', ?, 'app', ?)`);
  approval.run(JSON.stringify({ text: SECRET }), 'pending');
  approval.run('{}', 'approved');
  db.prepare(`INSERT INTO vault_notes (path, content_hash, last_written_by) VALUES ('a.md', 'h', 'app'), ('b.md', 'h', 'user')`).run();

  const today = localDay(new Date());
  const future = localDay(daysAgo(-3));
  const app = db.prepare(
    `INSERT INTO applications (company, status, step, fail_code, follow_up_on, master_hash, created_at, archived_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, 'h', ?, ?, ?)`,
  );
  const recent = daysAgo(0).toISOString();
  const old = daysAgo(30).toISOString();
  app.run(SECRET, 'processing', 'draft', null, null, recent, null, null);
  app.run(SECRET, 'draft_ready', null, null, null, recent, null, null); // needs
  app.run(SECRET, 'flagged', null, null, null, old, null, null); // needs
  app.run(SECRET, 'failed', 'match', 'x', null, old, null, null); // needs
  app.run(SECRET, 'final', 'render', null, null, old, null, null); // rendering: progress
  app.run(SECRET, 'final', null, 'render_failed', null, old, null, null); // needs
  app.run(SECRET, 'final', null, null, null, old, null, null); // needs: send it
  app.run(SECRET, 'final', null, null, today, old, null, null); // follow-up due wins
  app.run(SECRET, 'final', null, null, future, old, null, null); // needs: follow-up not due yet
  app.run(SECRET, 'applied', null, null, null, old, null, null);
  app.run(SECRET, 'withdrawn', null, null, null, old, null, null);
  app.run(SECRET, 'draft_ready', null, null, null, old, old, null); // archived
  app.run(null, 'failed', null, null, null, recent, null, recent); // deleted

  const r = await t.app.inject(t.authed({ url: '/api/dashboard' }));
  expect(r.statusCode).toBe(200);
  expect(r.body).not.toContain(SECRET);
  const body = r.json();

  const { ai } = body;
  expect(ai.days).toHaveLength(30);
  expect(ai.days[29].day).toBe(today);
  expect(ai.days.find((d: { day: string }) => d.day === today)).toEqual({ day: today, calls: 2, input_tokens: 1_000_000, output_tokens: 100_000, failures: 1, cost: 3 });
  expect(ai.days.find((d: { day: string }) => d.day === localDay(daysAgo(2)))).toMatchObject({ calls: 1, cost: 0.2 });
  expect(ai.days.find((d: { day: string }) => d.day === localDay(daysAgo(5)))).toMatchObject({ calls: 1, cost: null });
  expect(ai.days.find((d: { day: string }) => d.day === localDay(daysAgo(1)))).toEqual({ day: localDay(daysAgo(1)), calls: 0, input_tokens: 0, output_tokens: 0, failures: 0, cost: 0 });
  expect(ai.by_pipeline).toEqual([
    { pipeline: 'career-draft', calls: 2, input_tokens: 1_000_000, output_tokens: 100_000, cost: 3 },
    { pipeline: 'career-intake', calls: 1, input_tokens: 2_000_000, output_tokens: 0, cost: 0.2 },
    { pipeline: 'career-match', calls: 1, input_tokens: 10, output_tokens: 10, cost: null },
  ]);
  expect(ai.totals).toEqual({ calls: 4, input_tokens: 3_000_010, output_tokens: 100_010, failures: 1, cost: null });
  expect(ai.priced).toBe(false);

  expect(body.system).toEqual({
    provider: expect.any(String),
    approvals_pending: 1,
    jobs: { queued: 1, running: 1, failed_7d: 1 },
    vault_notes: 2,
    last_vault_commit: null, // not a git repo yet
  });
  expect(body.areas).toEqual({
    career: {
      by_status: { processing: 1, draft_ready: 1, flagged: 1, failed: 1, final: 5, applied: 1, withdrawn: 1 },
      archived: 1,
      new_this_week: 2,
      needs_you: 6,
      master: { exists: true, entries: 2, lines: 4 },
    },
    email: { connected: false },
    social: { connected: false },
  });

  await vaultGit(vault, 'init', '-q', '-b', 'main');
  await gitCommit(vault, 'test');
  const after = (await t.app.inject(t.authed({ url: '/api/dashboard' }))).json();
  expect(new Date(after.system.last_vault_commit).getTime()).toBeGreaterThan(Date.now() - 60_000);
  await t.app.close();
});
