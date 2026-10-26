import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { watch } from 'chokidar';
import type { FSWatcher } from 'chokidar';
import type { Database } from 'better-sqlite3';
import { audit } from '../db/audit.ts';
import { noteKey, sha256 } from './writer.ts';

const IGNORED_DIRS = new Set(['.git', '.obsidian', 'attachments', '.trash']);

/**
 * Records notes edited outside the app (Obsidian): a hash that differs from the stored one marks the note
 * `last_written_by='user'`, which makes the writer refuse to overwrite it. The initial scan catches edits made while the app was down.
 */
export function watchVault({ db, vaultDir }: { db: Database; vaultDir: string }): FSWatcher {
  const root = resolve(vaultDir);
  const getHash = db.prepare('SELECT content_hash FROM vault_notes WHERE path = ?');
  const markUser = db.prepare(
    `INSERT INTO vault_notes (path, content_hash, last_written_by) VALUES (?, ?, 'user')
     ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, last_written_by = 'user'`,
  );

  const onFile = (absPath: string) => {
    const key = noteKey(root, absPath);
    let hash: string;
    try {
      hash = sha256(readFileSync(absPath));
    } catch {
      return; // deleted or locked between the event and the read; the next event catches up
    }
    const row = getHash.get(key) as { content_hash: string } | undefined;
    if (row?.content_hash === hash) return; // the app's own write, or unchanged
    markUser.run(key, hash);
    audit(db, { actor: 'user', action: 'vault.user_edit', args: { path: key } });
    // Month 1: re-index the note here.
  };

  return watch(root, {
    ignored: (p, stats) => {
      const key = noteKey(root, p);
      return IGNORED_DIRS.has(key.split('/')[0]!) || (!!stats?.isFile() && !key.endsWith('.md'));
    },
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  })
    .on('add', onFile)
    .on('change', onFile);
}
