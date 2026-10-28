import { loadConfig } from '../config.ts';
import { initVault } from '../vault/init.ts';

async function main(): Promise<void> {
  const { vaultDir } = loadConfig();
  const created = await initVault(vaultDir);
  console.log(created.length ? `Vault ready at ${vaultDir}. Created: ${created.join(', ')}` : `Vault at ${vaultDir} is already initialised.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'Failed');
  process.exitCode = 1;
});
