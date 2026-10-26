import { openDb } from '../src/db/index.ts';
import type { Database } from '../src/db/index.ts';

/** In-memory database with all migrations applied. Extend here for per-ticket fixtures. */
export function makeTestDb(): Database {
  return openDb(':memory:');
}
