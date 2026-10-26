import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { initVault } from '../vault/init.ts';
import { sha256 } from '../vault/writer.ts';

// The app rewrites the question bank (W1-12 ticks answered questions), so it starts out as app-written.
// CLAUDE.md is yours: untracked, so the writer will never overwrite it.
const APP_OWNED = ['persona/_questions.md'];

async function main(): Promise<void> {
  const { vaultDir, dataDir } = loadConfig();
  const created = await initVault(vaultDir);
  const db = openDb(join(dataDir, 'brain.db'));
  try {
    const track = db.prepare(`INSERT OR IGNORE INTO vault_notes (path, content_hash, last_written_by) VALUES (?, ?, 'app')`);
    for (const rel of APP_OWNED.filter((p) => created.includes(p))) track.run(rel, sha256(readFileSync(join(vaultDir, rel))));
  } finally {
    db.close();
  }
  console.log(created.length ? `Vault ready at ${vaultDir}. Created: ${created.join(', ')}` : `Vault at ${vaultDir} is already initialised.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'Failed');
  process.exitCode = 1;
});
