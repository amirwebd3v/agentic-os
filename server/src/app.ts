import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyPluginAsync, FastifyServerOptions } from 'fastify';
import { repoRoot } from './config.ts';
import type { Config } from './config.ts';
import type { Database } from './db/index.ts';
import { loginRoute, requireSession } from './http/auth.ts';
import { allowedHosts, guards } from './http/guards.ts';
import { securityHeaders } from './http/headers.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    config: Config;
  }
}

export interface AppDeps {
  db: Database;
  config: Config;
  /** Registered under `/api`, behind the session check. Read `app.db` / `app.config` inside. */
  plugins?: FastifyPluginAsync[];
  /** Also allows the Vite dev server's host and origin (port 5173). */
  dev?: boolean;
  logger?: FastifyServerOptions['logger'];
  /** Built web app to serve; tests point this at a temp dir. */
  webDist?: string;
}

export const loggerOptions = {
  redact: [
    'authorization',
    '*.authorization',
    '*.headers.authorization',
    '"x-api-key"',
    '*["x-api-key"]',
    '*.headers["x-api-key"]',
    '*.headers.cookie',
    'apiKey',
    '*.apiKey',
    'token',
    '*.token',
  ],
  // The query string is dropped: /login?t=<token> must never reach a log.
  serializers: {
    req: (req: { method: string; url: string; ip: string }) => ({
      method: req.method,
      url: req.url.replace(/\?.*/s, ''),
      remoteAddress: req.ip,
    }),
  },
};

export async function buildApp({
  db,
  config,
  plugins = [],
  dev = false,
  logger = loggerOptions,
  webDist = resolve(repoRoot, 'web/dist'),
}: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger });
  app.decorate('db', db);
  app.decorate('config', config);
  app.addHook('onSend', securityHeaders);
  app.addHook('onRequest', guards(allowedHosts(config.server.port, dev)));

  const hasWeb = existsSync(join(webDist, 'index.html'));
  // Fastify's default 404 logs the raw URL, which would leak /login/?t=<token>.
  // Page navigations (not assets) get the SPA shell so client-side routes survive a reload.
  app.setNotFoundHandler((req, reply) =>
    hasWeb && req.method === 'GET' && !extname(req.url.split('?')[0]!) && req.headers.accept?.includes('text/html')
      ? reply.sendFile('index.html')
      : reply.code(404).send({ error: 'not found' }),
  );
  loginRoute(app, db);

  await app.register(
    async (api) => {
      api.addHook('onRequest', requireSession(db));
      api.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' })); // unknown /api paths need a session too
      api.get('/health', async () => ({ ok: true }));
      for (const plugin of plugins) await api.register(plugin);
    },
    { prefix: '/api' },
  );

  // wildcard: false registers only the built files, so unknown /api/* still reaches the session-checked 404 above.
  if (hasWeb) await app.register(fastifyStatic, { root: webDist, wildcard: false });
  return app;
}
