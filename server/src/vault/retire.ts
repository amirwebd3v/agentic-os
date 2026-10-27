// ponytail: one-shot cleanup of Week 1 content; delete this file (and its CLI and test) once the owner has run it (W2-12).
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { gitCommit, resolveNotePath, sha256 } from './writer.ts';

/** Exact old lines of the vault's CLAUDE.md template and what replaces them. A line you changed is left alone. */
const CLAUDE_PATCHES: [old: string, next: string][] = [
  [
    '- Top-level areas exist only with my approval: they are the list above.\n- Subareas are proposed by the app and become active after 3 items, or when I approve them.\n- Every session has exactly one primary area, plus any number of tags.\n',
    '- Top-level areas are the list above. To add one, add a line to that list: the app reads it at every boot.\n- Every item has exactly one primary area, plus any number of tags.\n',
  ],
  [
    '- `persona/`: who I am and how I work; `_questions.md` is the interview question bank.\n',
    '- `career/`: my master CV and contact details (`master.md`, `contact.md`); the app reads them to tailor applications.\n',
  ],
  ['- `journal/`: dated entries and session summaries.', '- `journal/`: dated entries.'],
];

const DB_DELETES: { table: string; sql: string }[] = [
  { table: 'sessions (and their messages and persona questions)', sql: 'DELETE FROM sessions' },
  { table: 'approvals of the removed types', sql: `DELETE FROM approvals WHERE action_type IN ('propose_category', 'persona_statement')` },
  { table: 'jobs of the removed kinds', sql: `DELETE FROM jobs WHERE kind IN ('categorize_session', 'extract_persona')` },
  { table: 'decider decisions about sessions', sql: `DELETE FROM decisions WHERE subject_type = 'session'` },
  { table: 'categorize eval cases', sql: `DELETE FROM eval_cases WHERE suite LIKE '%categoriz%'` },
  { table: 'categorize eval runs', sql: `DELETE FROM eval_runs WHERE suite LIKE '%categoriz%'` },
  { table: 'areas the model proposed and nobody approved', sql: `DELETE FROM areas WHERE status = 'proposed' AND created_by = 'model'` },
];

export interface RetirePlan {
  /** Vault-relative files to delete. */
  remove: string[];
  /** Files that match but that you edited, so they stay. */
  keep: string[];
  /** How many CLAUDE.md lines will be replaced, and how many weren't found verbatim. */
  claudeMd: { patched: number; notFound: number };
  /** Row counts per group. */
  db: { what: string; rows: number }[];
}

function files(vaultDir: string, rel: string): string[] {
  const abs = join(vaultDir, rel);
  if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) return [];
  if (!lstatSync(abs).isDirectory()) return [rel];
  return readdirSync(abs).flatMap((name) => files(vaultDir, `${rel}/${name}`));
}

/** Everything the removed features wrote: persona/, session notes, area indexes. */
function candidates(vaultDir: string): string[] {
  const areas = existsSync(join(vaultDir, 'wiki')) ? readdirSync(join(vaultDir, 'wiki')) : [];
  return [
    ...files(vaultDir, 'persona'),
    ...files(vaultDir, 'inbox/sessions'),
    ...areas.flatMap((a) => [...files(vaultDir, `wiki/${a}/sessions`), ...files(vaultDir, `wiki/${a}/_index.md`)]),
  ];
}

export function planRetire(vaultDir: string, db: Database): RetirePlan {
  const owned = db.prepare('SELECT content_hash, last_written_by FROM vault_notes WHERE path = ?');
  const remove: string[] = [];
  const keep: string[] = [];
  for (const rel of candidates(vaultDir)) {
    resolveNotePath(vaultDir, rel); // refuses anything outside the vault or inside .git / .obsidian
    // persona/ is removed whole (you asked for it); the rest only if the app wrote it and you didn't touch it.
    const mine = rel.startsWith('persona/');
    const row = owned.get(rel) as { content_hash: string; last_written_by: string } | undefined;
    const untouched = row?.last_written_by === 'app' && row.content_hash === sha256(readFileSync(join(vaultDir, rel)));
    (mine || untouched ? remove : keep).push(rel);
  }

  let patched = 0;
  let notFound = 0;
  if (existsSync(join(vaultDir, 'CLAUDE.md'))) {
    const text = readFileSync(join(vaultDir, 'CLAUDE.md'), 'utf8').replace(/\r\n/g, '\n');
    for (const [old] of CLAUDE_PATCHES) {
      if (text.includes(old)) patched++;
      else notFound++;
    }
  }

  const rows = DB_DELETES.map(({ table, sql }) => ({ what: table, rows: countFor(db, sql) }));
  return { remove, keep, claudeMd: { patched, notFound }, db: rows };
}

function countFor(db: Database, deleteSql: string): number {
  return db.prepare(deleteSql.replace('DELETE FROM', 'SELECT COUNT(*) FROM')).pluck().get() as number;
}

/** Deletes what `plan` lists. Callers back the database up first. Vault changes are committed before and after, so git can restore them. */
export async function applyRetire(vaultDir: string, db: Database, plan: RetirePlan): Promise<void> {
  await gitCommit(vaultDir, 'aos: restore point before retiring Week 1 content');

  for (const rel of plan.remove) rmSync(resolveNotePath(vaultDir, rel), { force: true });
  for (const dir of new Set(plan.remove.map((r) => r.split('/').slice(0, -1).join('/')))) pruneEmpty(vaultDir, dir);

  const claude = join(vaultDir, 'CLAUDE.md');
  if (existsSync(claude)) {
    const raw = readFileSync(claude, 'utf8');
    const crlf = raw.includes('\r\n');
    let text = raw.replace(/\r\n/g, '\n');
    for (const [old, next] of CLAUDE_PATCHES) text = text.replace(old, next);
    const out = crlf ? text.replace(/\n/g, '\r\n') : text;
    if (out !== raw) {
      const tmp = `${claude}.retire.tmp`;
      writeFileSync(tmp, out);
      renameSync(tmp, claude);
      db.prepare(
        `INSERT INTO vault_notes (path, content_hash, last_written_by) VALUES ('CLAUDE.md', ?, 'user')
         ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, last_written_by = 'user'`,
      ).run(sha256(out));
    }
  }

  db.transaction(() => {
    db.prepare(`UPDATE llm_calls SET job_id = NULL WHERE job_id IN (SELECT id FROM jobs WHERE kind IN ('categorize_session', 'extract_persona'))`).run();
    for (const { sql } of DB_DELETES) db.prepare(sql).run();
    const drop = db.prepare('DELETE FROM vault_notes WHERE path = ?');
    for (const rel of plan.remove) drop.run(rel);
  })();

  await gitCommit(vaultDir, 'aos: retire Week 1 content (persona, session notes, area indexes)');
}

function pruneEmpty(vaultDir: string, rel: string): void {
  for (let dir = rel; dir && dir !== 'wiki' && dir !== 'inbox'; dir = dir.split('/').slice(0, -1).join('/')) {
    const abs = join(vaultDir, dir);
    if (!existsSync(abs) || readdirSync(abs).length) return;
    rmdirSync(abs);
  }
}
