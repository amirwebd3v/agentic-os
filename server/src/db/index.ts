import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { recoverStaleLocks } from './jobs.ts';
import { migrate } from './migrate.ts';

export type { Database };

/**
 * Opens (creating if needed) the database, migrates it and recovers stale job locks.
 * Boot calls `openDb(join(config.dataDir, 'brain.db'))`. Backups: use better-sqlite3's native `db.backup(path)`.
 */
export function openDb(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  recoverStaleLocks(db);
  return db;
}
