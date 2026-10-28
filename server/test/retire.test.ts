import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { initVault } from '../src/vault/init.ts';
import { applyRetire, planRetire } from '../src/vault/retire.ts';
import { sha256, vaultGit } from '../src/vault/writer.ts';
import { makeTestDb } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const OLD_CLAUDE =
  '# Rules\n\n## Filing rules\n\n- Top-level areas exist only with my approval: they are the list above.\n- Subareas are proposed by the app and become active after 3 items, or when I approve them.\n- Every session has exactly one primary area, plus any number of tags.\n- Unsure? File to `inbox/`.\n\n## Folders\n\n- `persona/`: who I am and how I work; `_questions.md` is the interview question bank.\n- `journal/`: dated entries and session summaries.\n';

async function setup() {
  const vault = mkdtempSync(join(tmpdir(), 'aos-retire-'));
  dirs.push(vault);
  await initVault(vault);
  const db = makeTestDb();
  const put = (rel: string, text: string, ownedBy?: 'app' | 'user') => {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), text);
    if (ownedBy) db.prepare('INSERT INTO vault_notes (path, content_hash, last_written_by) VALUES (?, ?, ?)').run(rel, sha256(text), ownedBy);
  };
  put('persona/_questions.md', 'q', 'app');
  put('persona/health.md', 'about me', 'user');
  put('wiki/studies/sessions/a.md', 'summary a', 'app');
  put('wiki/studies/sessions/b.md', 'summary b', 'app');
  writeFileSync(join(vault, 'wiki/studies/sessions/b.md'), 'summary b, edited by me'); // changed after the app wrote it
  put('wiki/studies/_index.md', 'index', 'app');
  put('inbox/sessions/c.md', 'summary c', 'app');
  put('journal/mine.md', 'my own note');
  writeFileSync(join(vault, 'CLAUDE.md'), OLD_CLAUDE);

  const s = db.prepare(`INSERT INTO sessions (mode) VALUES ('chat') RETURNING id`).pluck().get() as number;
  db.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'user', 'hi')`).run(s);
  db.prepare(`INSERT INTO persona_questions (session_id, question_id) VALUES (?, 'q1')`).run(s);
  const ins = db.prepare(`INSERT INTO approvals (action_type, payload, proposed_by) VALUES (?, '{}', 'test')`);
  ins.run('persona_statement');
  ins.run('propose_category');
  ins.run('vault_conflict');
  const job = db.prepare(`INSERT INTO jobs (kind, idempotency_key, payload) VALUES (?, ?, '{}') RETURNING id`).pluck().get('categorize_session', 'k1') as number;
  db.prepare(`INSERT INTO llm_calls (pipeline, model, job_id) VALUES ('categorize', 'm', ?)`).run(job);
  db.prepare(`INSERT INTO jobs (kind, idempotency_key, payload) VALUES ('career_intake', 'k2', '{}')`).run();
  db.prepare(`INSERT INTO decisions (subject_type, subject_id, question) VALUES ('session', '1', 'area')`).run();
  db.prepare(`INSERT INTO decisions (subject_type, subject_id, question) VALUES ('mail', '1', 'area')`).run();
  db.prepare(`INSERT INTO eval_cases (suite, name, input, expected) VALUES ('categorize', 'c1', '{}', 'x')`).run();
  db.prepare(`INSERT INTO eval_runs (suite, model, total, correct, escalated, results) VALUES ('categorize', 'm', 1, 1, 0, '[]')`).run();
  db.prepare(`INSERT INTO areas (slug, name, status, created_by) VALUES ('ghost', 'Ghost', 'proposed', 'model')`).run();
  return { vault, db };
}

const count = (db: ReturnType<typeof makeTestDb>, sql: string) => db.prepare(sql).pluck().get() as number;

test('the plan lists what the app wrote, keeps what you edited, and changes nothing', async () => {
  const { vault, db } = await setup();
  const plan = planRetire(vault, db);
  expect(plan.remove.sort()).toEqual(['inbox/sessions/c.md', 'persona/_questions.md', 'persona/health.md', 'wiki/studies/_index.md', 'wiki/studies/sessions/a.md']);
  expect(plan.keep).toEqual(['wiki/studies/sessions/b.md']);
  expect(plan.claudeMd).toEqual({ patched: 3, notFound: 0 });
  expect(Object.fromEntries(plan.db.map((r) => [r.what.split(' ')[0], r.rows]))).toMatchObject({ sessions: 1, approvals: 2, jobs: 1 });
  expect(existsSync(join(vault, 'persona/health.md'))).toBe(true); // dry run
  expect(readFileSync(join(vault, 'CLAUDE.md'), 'utf8')).toBe(OLD_CLAUDE);
});

test('apply deletes them, patches CLAUDE.md, cleans the database, and leaves git restore points', async () => {
  const { vault, db } = await setup();
  await applyRetire(vault, db, planRetire(vault, db));

  for (const gone of ['persona', 'wiki/studies/sessions/a.md', 'wiki/studies/_index.md', 'inbox/sessions']) expect(existsSync(join(vault, gone))).toBe(false);
  expect(readFileSync(join(vault, 'wiki/studies/sessions/b.md'), 'utf8')).toBe('summary b, edited by me'); // yours stays
  expect(readFileSync(join(vault, 'journal/mine.md'), 'utf8')).toBe('my own note');
  const claude = readFileSync(join(vault, 'CLAUDE.md'), 'utf8');
  expect(claude).toContain('To add one, add a line to that list');
  expect(claude).toContain('- `career/`:');
  expect(claude).not.toContain('persona/');
  expect(claude).toContain('- `journal/`: dated entries.');

  expect(count(db, 'SELECT COUNT(*) FROM sessions')).toBe(0);
  expect(count(db, 'SELECT COUNT(*) FROM messages')).toBe(0);
  expect(count(db, 'SELECT COUNT(*) FROM persona_questions')).toBe(0);
  expect(count(db, `SELECT COUNT(*) FROM approvals`)).toBe(1); // the vault_conflict stays
  expect(count(db, `SELECT COUNT(*) FROM jobs`)).toBe(1); // career_intake stays
  expect(count(db, `SELECT COUNT(*) FROM llm_calls WHERE job_id IS NOT NULL`)).toBe(0);
  expect(count(db, `SELECT COUNT(*) FROM decisions`)).toBe(1); // the mail decision stays
  expect(count(db, `SELECT COUNT(*) FROM eval_cases`) + count(db, `SELECT COUNT(*) FROM eval_runs`)).toBe(0);
  expect(count(db, `SELECT COUNT(*) FROM areas WHERE slug = 'ghost'`)).toBe(0);
  expect(count(db, `SELECT COUNT(*) FROM vault_notes WHERE path LIKE 'persona/%'`)).toBe(0);

  const log = await vaultGit(vault, 'log', '--format=%s');
  expect(log).toContain('restore point before retiring');
  expect(log).toContain('retire Week 1 content');
});

test('a CRLF CLAUDE.md keeps its line endings, and an edited line is left alone', async () => {
  const { vault, db } = await setup();
  const edited = OLD_CLAUDE.replace('- `journal/`: dated entries and session summaries.', '- `journal/`: my own wording.').replace(/\n/g, '\r\n');
  writeFileSync(join(vault, 'CLAUDE.md'), edited);
  const plan = planRetire(vault, db);
  expect(plan.claudeMd).toEqual({ patched: 2, notFound: 1 });
  await applyRetire(vault, db, plan);
  const out = readFileSync(join(vault, 'CLAUDE.md'), 'utf8');
  expect(out).toContain('my own wording');
  expect(out.replace(/\r\n/g, '')).not.toContain('\n');
});
