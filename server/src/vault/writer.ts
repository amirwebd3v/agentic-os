import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Database } from 'better-sqlite3';
import { audit } from '../db/audit.ts';
import { parseNote, stringifyNote } from './frontmatter.ts';
import type { Frontmatter } from './frontmatter.ts';

const run = promisify(execFile);
const COMMIT_DELAY_MS = 30_000;
const PROTECTED_DIRS = new Set(['.git', '.obsidian', '.trash']);

export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

const isInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};

/** Vault-relative key with forward slashes, shared by writer and watcher so both address the same row. */
export const noteKey = (vaultDir: string, absPath: string): string => relative(vaultDir, absPath).split(sep).join('/');

/**
 * Resolves a vault-relative `.md` path, refusing anything that could land outside the vault:
 * absolute or drive paths, `..`, protected folders, and symlinked/junctioned parents that point elsewhere.
 */
export function resolveNotePath(vaultDir: string, relPath: string): string {
  const root = resolve(vaultDir);
  const abs = resolve(root, relPath);
  if (isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || relPath.includes('\0') || !isInside(abs, root)) {
    throw new Error(`Path escapes the vault: ${relPath}`);
  }
  if (!abs.endsWith('.md')) throw new Error(`Only .md notes can be written: ${relPath}`);
  if (PROTECTED_DIRS.has(noteKey(root, abs).split('/')[0]!)) throw new Error(`Protected vault folder: ${relPath}`);
  let existing = dirname(abs);
  while (!existsSync(existing)) existing = dirname(existing);
  const realRoot = realpathSync(root);
  const realExisting = realpathSync(existing);
  if (realExisting !== realRoot && !isInside(realExisting, realRoot)) throw new Error(`Path escapes the vault: ${relPath}`);
  return abs;
}

/** Stages everything and commits if anything changed. Never pushes: the vault has no remote. */
export async function gitCommit(vaultDir: string, message: string): Promise<boolean> {
  const git = (...args: string[]) => run('git', ['-C', vaultDir, ...args]);
  await git('add', '-A');
  try {
    await git('diff', '--cached', '--quiet');
    return false; // exit 0: nothing staged
  } catch {
    await git('-c', 'user.name=Agentic OS', '-c', 'user.email=agentic-os@localhost', 'commit', '-q', '-m', message);
    return true;
  }
}

export type NoteInput = Partial<Frontmatter> & Pick<Frontmatter, 'area'>;

interface NoteRow {
  content_hash: string;
  last_written_by: 'app' | 'user';
}

export function createWriter({ db, vaultDir, commit = true }: { db: Database; vaultDir: string; commit?: boolean }) {
  const root = resolve(vaultDir);
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let committing: Promise<unknown> = Promise.resolve();

  const flush = (): Promise<unknown> => {
    clearTimeout(timer);
    timer = undefined;
    if (pending.size === 0) return committing;
    const paths = [...pending];
    pending.clear();
    const message = `aos: update ${paths.length} note${paths.length > 1 ? 's' : ''}\n\n${paths.join('\n')}`;
    committing = committing
      .then(() => gitCommit(root, message))
      .catch((err: unknown) => console.error(`vault commit failed: ${(err as Error).message}`));
    return committing;
  };

  const upsert = db.prepare(
    `INSERT INTO vault_notes (path, content_hash, last_written_by) VALUES (?, ?, 'app')
     ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, last_written_by = 'app'`,
  );

  /**
   * Writes a note unless it was changed outside the app. A note counts as changed when it exists but is untracked,
   * was last written by the user (the watcher saw an edit), or no longer matches the hash the app last wrote.
   * Then nothing is written: the proposal goes to the review queue as a `vault_conflict` approval.
   */
  function writeNote(relPath: string, body: string, input: NoteInput): 'written' | 'conflict' {
    const abs = resolveNotePath(root, relPath);
    const key = noteKey(root, abs);
    const row = db.prepare('SELECT content_hash, last_written_by FROM vault_notes WHERE path = ?').get(key) as NoteRow | undefined;
    const current = existsSync(abs) ? readFileSync(abs) : undefined;
    const now = new Date().toISOString();

    const conflict = current && (!row || row.last_written_by === 'user' || row.content_hash !== sha256(current));
    let previous: Partial<Frontmatter> = {};
    if (current && !conflict) {
      try {
        previous = parseNote(current.toString('utf8')).fm; // keep id and created across rewrites
      } catch {
        // the app's own note without valid frontmatter: start fresh
      }
    }
    const text = stringifyNote(body, {
      id: previous.id ?? randomUUID(),
      tags: [],
      sensitivity: 1,
      source: 'app',
      created: previous.created ?? now,
      ...input,
      updated: now,
    });

    if (conflict) {
      db.prepare(`INSERT INTO approvals (action_type, payload, proposed_by) VALUES ('vault_conflict', ?, 'app')`).run(
        JSON.stringify({ path: key, current_hash: sha256(current), content: text }),
      );
      audit(db, { actor: 'app', action: 'vault.conflict', args: { path: key } });
      return 'conflict';
    }

    const tmp = `${abs}.tmp`;
    mkdirSync(dirname(abs), { recursive: true });
    // ponytail: an Obsidian save between the hash check and the rename is lost; add a re-check under a lock if that ever bites
    try {
      writeFileSync(tmp, text);
      db.transaction(() => {
        upsert.run(key, sha256(text));
        renameSync(tmp, abs); // throws → row rolls back
      })();
    } finally {
      rmSync(tmp, { force: true });
    }

    if (commit) {
      pending.add(key);
      timer ??= setTimeout(() => void flush(), COMMIT_DELAY_MS).unref();
    }
    return 'written';
  }

  return { writeNote, flush };
}
