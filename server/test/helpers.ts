import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyPluginAsync, FastifyServerOptions, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import type { Database } from '../src/db/index.ts';
import { createLoginToken } from '../src/http/auth.ts';

/** In-memory database with all migrations applied. Extend here for per-ticket fixtures. */
export function makeTestDb(): Database {
  return openDb(':memory:');
}

export const HOST = '127.0.0.1:3000';
export const ORIGIN = `http://${HOST}`;

export interface TestApp {
  app: FastifyInstance;
  db: Database;
  /** `aos_session=<token>` when `loggedIn`, else empty. */
  cookie: string;
  /** An unused one-time login token. */
  loginToken: string;
  /** Adds the host, origin, cookie and `x-aos` headers a logged-in browser tab would send. */
  authed: (req: InjectOptions) => InjectOptions;
  /** Id of an area by slug (seeded by migration 0001). */
  areaId: (slug: string) => number;
}

/**
 * App on an in-memory db, port 3000, logging off. `plugins` mount under `/api` like in main.ts.
 * `webDist` defaults to a missing dir so a local `pnpm build` can't change test results.
 */
export async function buildTestApp({
  loggedIn = false,
  plugins = [],
  logger = false,
  webDist = join(tmpdir(), 'aos-no-web-dist'),
}: {
  loggedIn?: boolean;
  plugins?: FastifyPluginAsync[];
  logger?: FastifyServerOptions['logger'];
  webDist?: string;
} = {}): Promise<TestApp> {
  const db = makeTestDb();
  const config = parseConfig({ vaultDir: join(tmpdir(), 'aos-test-vault'), dataDir: join(tmpdir(), 'aos-test-data') });
  const app = await buildApp({ db, config, plugins, logger, webDist });
  let cookie = '';
  if (loggedIn) {
    const r = await app.inject({ url: `/login?t=${createLoginToken(db)}`, headers: { host: HOST } });
    cookie = String(r.headers['set-cookie']).split(';')[0] ?? '';
  }
  const authed = (req: InjectOptions): InjectOptions => ({
    ...req,
    headers: { host: HOST, origin: ORIGIN, cookie, 'x-aos': '1', ...req.headers },
  });
  const areaId = (slug: string) => (db.prepare('SELECT id FROM areas WHERE slug = ?').get(slug) as { id: number }).id;
  return { app, db, cookie, loginToken: createLoginToken(db), authed, areaId };
}
