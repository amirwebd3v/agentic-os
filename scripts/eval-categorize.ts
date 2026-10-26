// `pnpm eval:categorize`: runs the real decider + Claude on server/test/fixtures/sessions/*.json and prints a confusion table.
// Keys come from `.env` (AOS_ENV_FILE to point elsewhere). Everything is written to a fresh temp vault and db, outside the repo.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enqueueCategorize, lastMessageId } from '../server/src/chat/idle.ts';
import { parseConfig, readAppEnv, repoRoot } from '../server/src/config.ts';
import { openDb } from '../server/src/db/index.ts';
import { categorizeSession } from '../server/src/jobs/categorize-session.ts';
import { runNext } from '../server/src/jobs/runner.ts';
import { getSecret } from '../server/src/secrets.ts';
import { syncAreasFromVault } from '../server/src/vault/areas.ts';
import { initVault } from '../server/src/vault/init.ts';
import { createWriter } from '../server/src/vault/writer.ts';

interface Fixture {
  expected_area: string; // an area slug, or "new" for a top-level proposal
  messages: { role: 'user' | 'assistant'; content: string }[];
}

const SUITE = 'categorize';
const fixturesDir = fileURLToPath(new URL('../server/test/fixtures/sessions/', import.meta.url));

if (!getSecret('anthropic')) throw new Error('No anthropic key: set ANTHROPIC_API_KEY in .env (or AOS_ENV_FILE).');
if (!getSecret('laya')) console.warn('No laya key: the decider is skipped, Claude files alone.');

const tmp = mkdtempSync(join(tmpdir(), 'aos-eval-'));
const config = parseConfig({ vaultDir: join(tmp, 'vault'), dataDir: join(tmp, 'data') }, repoRoot, readAppEnv());
await initVault(config.vaultDir);
const db = openDb(join(config.dataDir, 'brain.db'));
syncAreasFromVault(db, config.vaultDir);
const handle = categorizeSession({ db, config, writer: createWriter({ db, vaultDir: config.vaultDir, commit: false }) });

interface Result {
  case: string;
  expected: string;
  predicted: string;
  proposed: string | null;
  decider: string | null;
  confidence: number | null;
  escalated: boolean;
  correct: boolean;
  ms: number;
  error: string | null;
}
const results: Result[] = [];
for (const file of readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort()) {
  const name = file.replace(/\.json$/, '');
  const fx = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as Fixture;
  db.prepare(
    `INSERT INTO eval_cases (suite, name, input, expected) VALUES (?, ?, ?, ?)
     ON CONFLICT (suite, name) DO UPDATE SET input = excluded.input, expected = excluded.expected`,
  ).run(SUITE, name, JSON.stringify(fx.messages), fx.expected_area);

  const sid = (db.prepare(`INSERT INTO sessions (mode) VALUES ('chat') RETURNING id`).get() as { id: number }).id;
  for (const m of fx.messages) db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)').run(sid, m.role, m.content);
  enqueueCategorize(db, sid, lastMessageId(db, sid)!);
  const t0 = Date.now();
  let error: string | null = null;
  try {
    await runNext(db, { categorize_session: handle });
  } catch (err) {
    error = (err as Error).message;
  }

  const s = db
    .prepare(`SELECT s.filing_status, COALESCE(p.slug, a.slug) top FROM sessions s LEFT JOIN areas a ON a.id = s.area_id LEFT JOIN areas p ON p.id = a.parent_id WHERE s.id = ?`)
    .get(sid) as { filing_status: string | null; top: string | null };
  const proposed = db
    .prepare(
      `SELECT json_extract(payload, '$.slug') slug FROM approvals, json_each(json_extract(payload, '$.session_ids')) j
       WHERE action_type = 'propose_category' AND j.value = ?`,
    )
    .get(sid) as { slug: string } | undefined;
  const d = db.prepare(`SELECT answer, confidence, escalated FROM decisions WHERE subject_id = ? ORDER BY id DESC`).get(String(sid)) as
    | { answer: string; confidence: number; escalated: number }
    | undefined;
  const predicted = error ? 'error' : proposed ? 'new' : (s.top ?? 'inbox');
  results.push({
    case: name,
    expected: fx.expected_area,
    predicted,
    proposed: proposed?.slug ?? null,
    decider: d?.answer ?? null,
    confidence: d?.confidence ?? null,
    escalated: !d || d.escalated === 1,
    correct: predicted === fx.expected_area,
    ms: Date.now() - t0,
    error,
  });
}

const pad = (s: unknown, n: number) => String(s ?? '-').padEnd(n);
console.log(`\n${pad('case', 24)}${pad('expected', 22)}${pad('predicted', 22)}${pad('decider (conf)', 30)}esc  ok   ms`);
for (const r of results) {
  const dec = r.decider ? `${r.decider} (${r.confidence!.toFixed(2)})` : 'down';
  console.log(`${pad(r.case, 24)}${pad(r.expected, 22)}${pad(r.predicted + (r.proposed ? `:${r.proposed}` : ''), 22)}${pad(dec, 30)}${pad(r.escalated ? 'y' : 'n', 5)}${pad(r.correct ? 'y' : 'N', 5)}${r.ms}`);
  if (r.error) console.log(`  error: ${r.error}`);
}

// Confusion table: rows = expected, columns = predicted (numbered to keep it narrow).
const labels = [...new Set(results.flatMap((r) => [r.expected, r.predicted]))].sort();
const w = Math.max(...labels.map((l) => l.length)) + 6;
console.log(`
Confusion (rows expected, columns predicted)
${pad('', w)}${labels.map((_, i) => pad(i + 1, 4)).join('')}`);
for (const [i, exp] of labels.entries()) {
  const cells = labels.map((pred) => pad(results.filter((r) => r.expected === exp && r.predicted === pred).length || '.', 4));
  console.log(`${pad(`${i + 1} ${exp}`, w)}${cells.join('')}`);
}

const correct = results.filter((r) => r.correct).length;
const escalated = results.filter((r) => r.escalated).length;
db.prepare(`INSERT INTO eval_runs (suite, model, total, correct, escalated, results) VALUES (?, ?, ?, ?, ?, ?)`).run(
  SUITE, `${config.decider.model} + ${config.llm.models.work}`, results.length, correct, escalated, JSON.stringify(results),
);
console.log(`\n${correct}/${results.length} correct · escalated ${escalated}/${results.length} (${Math.round((100 * escalated) / results.length)}%) · target ≥ 9`);
console.log(`Vault with the notes: ${config.vaultDir}`);
db.close();
process.exitCode = correct >= 9 ? 0 : 1;
