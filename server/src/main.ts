import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { createLoginToken, loginUrl } from './http/auth.ts';
import { approvalRoutes } from './http/routes/approvals.ts';
import { areaRoutes } from './http/routes/areas.ts';
import { providerRoutes } from './http/routes/provider.ts';
import { sessionRoutes } from './http/routes/sessions.ts';
import { syncAreasFromVault } from './vault/areas.ts';
import { watchVault } from './vault/watch.ts';

// Feature plugins, mounted under /api behind the session check. One line per ticket.
const plugins: FastifyPluginAsync[] = [providerRoutes, areaRoutes, sessionRoutes(), approvalRoutes()];

const config = loadConfig();
const db = openDb(join(config.dataDir, 'brain.db'));
const app = await buildApp({ db, config, plugins, dev: process.argv.includes('--dev') });
try {
  syncAreasFromVault(db, config.vaultDir);
} catch (err) {
  // A CLAUDE.md typo must not take the app down: keep the current areas and say why.
  app.log.error(`Area sync skipped (run \`pnpm vault:init\` if the vault is missing): ${(err as Error).message}`);
}
watchVault({ db, vaultDir: config.vaultDir });
await app.listen({ host: '127.0.0.1', port: config.server.port });
console.log(`Open ${loginUrl(config.server.port, createLoginToken(db))}`);
