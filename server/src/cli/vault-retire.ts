import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { applyRetire, planRetire } from '../vault/retire.ts';

const apply = process.argv.includes('--apply');
const { vaultDir, dataDir } = loadConfig();
const dbPath = join(dataDir, 'brain.db');
const db = openDb(dbPath);
try {
  const plan = planRetire(vaultDir, db);
  console.log(`Vault: ${vaultDir}\n`);
  console.log(`Files to delete (${plan.remove.length}):`);
  for (const f of plan.remove) console.log(`  - ${f}`);
  console.log(`\nFiles kept because you edited them (${plan.keep.length}):`);
  for (const f of plan.keep) console.log(`  = ${f}`);
  console.log(`\nCLAUDE.md: ${plan.claudeMd.patched} old line group(s) will be replaced; ${plan.claudeMd.notFound} not found verbatim (edit by hand if still present).`);
  console.log('\nDatabase rows to delete:');
  for (const { what, rows } of plan.db) console.log(`  ${String(rows).padStart(5)}  ${what}`);

  if (!apply) {
    console.log('\nNothing was changed. Stop the server, then run `pnpm vault:retire --apply` to do it.');
  } else {
    // wal_checkpoint so the copy is a complete database file.
    db.pragma('wal_checkpoint(TRUNCATE)');
    const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (existsSync(dbPath)) copyFileSync(dbPath, backup);
    await applyRetire(vaultDir, db, plan);
    console.log(`\nDone. Database backup: ${backup}\nVault changes are two git commits in the vault (restore with git).`);
  }
} finally {
  db.close();
}
