import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/index.ts';
import { createLoginToken, loginUrl } from '../http/auth.ts';

// Prints a fresh one-time login link (valid 10 minutes) for the running server.
const config = loadConfig();
const db = openDb(join(config.dataDir, 'brain.db'));
console.log(`Open ${loginUrl(config.server.port, createLoginToken(db))}`);
db.close();
