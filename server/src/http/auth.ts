import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Database } from '../db/index.ts';

const SESSION_COOKIE = 'aos_session';
const LOGIN_TTL_MS = 10 * 60_000;
const SESSION_TTL_S = 30 * 24 * 3600;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const newToken = (): string => randomBytes(32).toString('base64url');
const isoIn = (ms: number): string => new Date(Date.now() + ms).toISOString();

/** Creates a single-use login token valid for 10 minutes. Only its sha256 is stored. */
export function createLoginToken(db: Database): string {
  const token = newToken();
  db.prepare('DELETE FROM login_tokens WHERE expires_at <= ?').run(isoIn(0));
  db.prepare('INSERT INTO login_tokens (token_hash, expires_at) VALUES (?, ?)').run(sha256(token), isoIn(LOGIN_TTL_MS));
  return token;
}

export const loginUrl = (port: number, token: string): string => `http://127.0.0.1:${port}/login?t=${token}`;

/** Consumes a login token and returns a new session token, or null if it is unknown, used or expired. */
function redeemLoginToken(db: Database, token: string): string | null {
  if (!TOKEN_SHAPE.test(token)) return null;
  return db
    .transaction(() => {
      const hit = db
        .prepare('DELETE FROM login_tokens WHERE token_hash = ? AND expires_at > ? RETURNING 1')
        .get(sha256(token), isoIn(0));
      if (!hit) return null;
      db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(isoIn(0));
      const session = newToken();
      db.prepare('INSERT INTO auth_sessions (token_hash, expires_at) VALUES (?, ?)').run(
        sha256(session),
        isoIn(SESSION_TTL_S * 1000),
      );
      return session;
    })
    .immediate();
}

// Every value of the cookie: cookies aren't port-isolated, so another localhost page can plant a decoy aos_session.
// ponytail: no logout or revocation yet, add DELETE FROM auth_sessions when the UI needs it
const readCookies = (header: string | undefined, name: string): string[] =>
  (header ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c.startsWith(`${name}=`))
    .map((c) => c.slice(name.length + 1));

function hasValidSession(db: Database, cookieHeader: string | undefined): boolean {
  const query = db.prepare('SELECT 1 FROM auth_sessions WHERE token_hash = ? AND expires_at > ?');
  return readCookies(cookieHeader, SESSION_COOKIE).some((t) => TOKEN_SHAPE.test(t) && !!query.get(sha256(t), isoIn(0)));
}

export const requireSession =
  (db: Database): onRequestAsyncHookHandler =>
  async (req, reply) => {
    if (!hasValidSession(db, req.headers.cookie)) return reply.code(401).send({ error: 'not logged in' });
  };

/**
 * `GET /login?t=<token>`: exchanges a one-time token for the session cookie, then redirects to the app: `/`, or in
 * dev the Vite page (the server has no web/dist then). Cookies ignore the port, so the session works on both.
 */
export function loginRoute(app: FastifyInstance, db: Database, dev = false): void {
  // No HEAD route: a prefetch or link preview must not burn the one-time token.
  app.get('/login', { exposeHeadRoute: false }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    // An <img> or fetch from any web page reaches this; refusing them unaudited keeps the audit log from being flooded.
    const dest = req.headers['sec-fetch-dest'];
    if (dest !== undefined && dest !== 'document') return reply.code(403).send({ error: 'open the login link directly' });
    const { t } = req.query as { t?: unknown };
    const session = typeof t === 'string' ? redeemLoginToken(db, t) : null;
    audit(db, { actor: 'user', action: 'auth.login', args: { ip: req.ip }, decision: session ? 'success' : 'failure' });
    if (!session) return reply.code(401).send({ error: 'invalid or expired login link' });
    reply.header('set-cookie', `${SESSION_COOKIE}=${session}; Max-Age=${SESSION_TTL_S}; Path=/; HttpOnly; SameSite=Strict`);
    return reply.redirect(dev ? 'http://127.0.0.1:5173/' : '/');
  });
}
