import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

/**
 * Applies every `NNNN_*.sql` whose number is above `user_version`, each in its own transaction.
 * Foreign keys are off while they run (SQLite's table-rebuild procedure: `PRAGMA foreign_keys` can't change inside a
 * transaction, and with them on, dropping a parent table would check its children mid-rebuild); each migration must
 * leave `foreign_key_check` clean before it commits.
 */
export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const files = readdirSync(migrationsDir)
    .map((name) => ({ name, version: Number(/^(\d{4})_.*\.sql$/.exec(name)?.[1]) }))
    .filter((f) => f.version > current)
    .sort((a, b) => a.version - b.version);
  if (!files.length) return;
  const fk = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  try {
    for (const { name, version } of files) {
      const sql = readFileSync(`${migrationsDir}${name}`, 'utf8');
      db.transaction(() => {
        db.exec(sql);
        if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error(`migration ${name}: foreign key check failed`);
        db.pragma(`user_version = ${version}`);
      })();
    }
  } finally {
    db.pragma(`foreign_keys = ${fk ? 'ON' : 'OFF'}`);
  }
}
