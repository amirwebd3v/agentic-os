import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import { audit } from '../db/audit.ts';
import type { Database } from '../db/index.ts';

export const SESSION_COOKIE = 'aos_session';
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
export function redeemLoginToken(db: Database, token: string): string | null {
  if (!TOKEN_SHAPE.test(token)) return null;
  return db
    .transaction(() => {
      const hit = db
        .prepare('DELETE FROM login_tokens WHERE token_hash = ? AND expires_at > ? RETURNING 1')
        .get(sha256(token), isoIn(0));
      if (!hit) return null;
      const session = newToken();
      db.prepare('INSERT INTO auth_sessions (token_hash, expires_at) VALUES (?, ?)').run(
        sha256(session),
        isoIn(SESSION_TTL_S * 1000),
      );
      return session;
    })
    .immediate();
}

const readCookie = (header: string | undefined, name: string): string | undefined =>
  header
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

export function hasValidSession(db: Database, cookieHeader: string | undefined): boolean {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token || !TOKEN_SHAPE.test(token)) return false;
  return !!db.prepare('SELECT 1 FROM auth_sessions WHERE token_hash = ? AND expires_at > ?').get(sha256(token), isoIn(0));
}

export const requireSession =
  (db: Database): onRequestAsyncHookHandler =>
  async (req, reply) => {
    if (!hasValidSession(db, req.headers.cookie)) return reply.code(401).send({ error: 'not logged in' });
  };

/** `GET /login?t=<token>`: exchanges a one-time token for the session cookie, then redirects to `/`. */
export function loginRoute(app: FastifyInstance, db: Database): void {
  app.get('/login', async (req, reply) => {
    const { t } = req.query as { t?: unknown };
    const session = typeof t === 'string' ? redeemLoginToken(db, t) : null;
    audit(db, { actor: 'user', action: 'auth.login', args: { ip: req.ip }, decision: session ? 'success' : 'failure' });
    reply.header('cache-control', 'no-store');
    if (!session) return reply.code(401).send({ error: 'invalid or expired login link' });
    reply.header('set-cookie', `${SESSION_COOKIE}=${session}; Max-Age=${SESSION_TTL_S}; Path=/; HttpOnly; SameSite=Strict`);
    return reply.redirect('/');
  });
}
