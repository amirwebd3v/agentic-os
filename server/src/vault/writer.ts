import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

// Per segment: drive letters and NTFS streams (`:`), 8.3 aliases like GIT~1, names Windows trims (`.git.`), device names.
const BAD_SEGMENT = /[:\0]|~\d|[. ]$|^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/** True when an existing directory, after following junctions/symlinks, is the vault or inside it. */
const dirInVault = (dir: string, root: string): boolean => {
  const real = realpathSync(dir);
  const realRoot = realpathSync(root);
  return real === realRoot || isInside(real, realRoot);
};

/**
 * Resolves a vault-relative `.md` path, refusing anything that could land outside the vault or in a hidden alias:
 * absolute paths, `..`, Windows name tricks, protected folders, and parents that link elsewhere.
 */
export function resolveNotePath(vaultDir: string, relPath: string): string {
  const root = resolve(vaultDir);
  const abs = resolve(root, relPath);
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  if (isAbsolute(relPath) || segments.some((s) => BAD_SEGMENT.test(s)) || !isInside(abs, root)) {
    throw new Error(`Path escapes the vault or has an unsafe name: ${relPath}`);
  }
  if (!abs.endsWith('.md')) throw new Error(`Only .md notes can be written: ${relPath}`);
  if (PROTECTED_DIRS.has(noteKey(root, abs).split('/')[0]!.toLowerCase())) throw new Error(`Protected vault folder: ${relPath}`);
  let existing = dirname(abs);
  while (!existsSync(existing)) existing = dirname(existing);
  if (!dirInVault(existing, root)) throw new Error(`Path escapes the vault: ${relPath}`);
  return abs;
}

/**
 * Runs git in the vault. Inherited GIT_* vars (git hooks export GIT_DIR) would silently retarget it at another repo:
 * a `git init` under a pre-push hook once set `core.bare=true` on the code repo.
 */
export const vaultGit = async (vaultDir: string, ...args: string[]): Promise<string> => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
  return (await run('git', ['-C', vaultDir, ...args], { env, encoding: 'utf8' })).stdout;
};

/** Stages everything and commits if anything changed. Never pushes: the vault has no remote. */
export async function gitCommit(vaultDir: string, message: string): Promise<boolean> {
  await vaultGit(vaultDir, 'add', '-A');
  try {
    await vaultGit(vaultDir, 'diff', '--cached', '--quiet');
    return false; // exit 0: nothing staged
  } catch {
    await vaultGit(vaultDir, '-c', 'user.name=Agentic OS', '-c', 'user.email=agentic-os@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
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

  const refreshConflict = db.prepare(
    `UPDATE approvals SET payload = ? WHERE action_type = 'vault_conflict' AND status = 'pending' AND json_extract(payload, '$.path') = ?`,
  );
  const insertConflict = db.prepare(`INSERT INTO approvals (action_type, payload, proposed_by) VALUES ('vault_conflict', ?, 'app')`);

  /**
   * Writes a note only if the app is its last known author: a new path, or the app's own note still matching
   * the hash it wrote. Anything else (untracked file, user edit seen by the watcher, changed hash, note deleted
   * or renamed by the user) writes nothing and queues a `vault_conflict` approval, one pending per path.
   */
  function writeNote(relPath: string, body: string, input: NoteInput): 'written' | 'conflict' {
    const abs = resolveNotePath(root, relPath);
    const key = noteKey(root, abs);
    const row = db.prepare('SELECT content_hash, last_written_by FROM vault_notes WHERE path = ?').get(key) as NoteRow | undefined;
    const current = existsSync(abs) ? readFileSync(abs) : undefined;
    const now = new Date().toISOString();

    const ownedByApp = row?.last_written_by === 'app' && current !== undefined && row.content_hash === sha256(current);
    const conflict = (row || current) && !ownedByApp;
    let previous: Partial<Frontmatter> = {};
    if (ownedByApp) {
      try {
        previous = parseNote(current.toString('utf8')).fm; // keeps id, created, sensitivity, tags across rewrites
      } catch {
        // the app's own note without valid frontmatter: start fresh
      }
    }
    const text = stringifyNote(body, { id: randomUUID(), tags: [], sensitivity: 1, source: 'app', created: now, ...previous, ...input, updated: now });

    if (conflict) {
      const payload = JSON.stringify({ path: key, current_hash: current ? sha256(current) : null, content: text });
      db.transaction(() => {
        if (refreshConflict.run(payload, key).changes === 0) insertConflict.run(payload);
        audit(db, { actor: 'app', action: 'vault.conflict', args: { path: key } });
      })();
      return 'conflict';
    }

    mkdirSync(dirname(abs), { recursive: true });
    if (!dirInVault(dirname(abs), root)) throw new Error(`Path escapes the vault: ${relPath}`); // a parent swapped for a link meanwhile
    const tmp = `${abs}.${randomUUID()}.tmp`; // unique + 'wx': never follows or clobbers an existing file
    // ponytail: an Obsidian save between the hash check and the rename is lost (sync code, microseconds); re-check under a lock if it ever bites
    try {
      const fd = openSync(tmp, 'wx');
      try {
        writeFileSync(fd, text);
        fsyncSync(fd); // a crash after rename must not leave an empty note
      } finally {
        closeSync(fd);
      }
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
