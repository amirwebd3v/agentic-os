import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Applies every `NNNN_*.sql` whose number is above `user_version`, each in its own transaction. */
export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const files = readdirSync(migrationsDir)
    .map((name) => ({ name, version: Number(/^(\d{4})_.*\.sql$/.exec(name)?.[1]) }))
    .filter((f) => f.version > current)
    .sort((a, b) => a.version - b.version);
  for (const { name, version } of files) {
    const sql = readFileSync(`${migrationsDir}${name}`, 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  }
}
