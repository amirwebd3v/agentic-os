import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { createLoginToken, loginUrl } from './http/auth.ts';
import { providerRoutes } from './http/routes/provider.ts';

// Feature plugins, mounted under /api behind the session check. One line per ticket.
const plugins: FastifyPluginAsync[] = [providerRoutes];

const config = loadConfig();
const db = openDb(join(config.dataDir, 'brain.db'));
const app = await buildApp({ db, config, plugins, dev: process.argv.includes('--dev') });
await app.listen({ host: '127.0.0.1', port: config.server.port });
console.log(`Open ${loginUrl(config.server.port, createLoginToken(db))}`);
