import { Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { loggerOptions } from '../src/app.ts';
import { createLoginToken } from '../src/http/auth.ts';
import { buildTestApp, HOST, ORIGIN } from './helpers.ts';

describe('local hardening', () => {
  test('foreign Host is rejected (DNS rebinding)', async () => {
    const { app } = await buildTestApp();
    const r = await app.inject({ url: '/api/health', headers: { host: 'evil.example:3000' } });
    expect(r.statusCode).toBe(403);
  });
  test('cross-origin POST is rejected', async () => {
    const { app, cookie } = await buildTestApp({ loggedIn: true });
    const r = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { host: HOST, origin: 'https://evil.example', cookie, 'x-aos': '1' },
    });
    expect(r.statusCode).toBe(403);
  });
  test('POST without X-AOS is rejected', async () => {
    const { app, cookie } = await buildTestApp({ loggedIn: true });
    const r = await app.inject({ method: 'POST', url: '/api/sessions', headers: { host: HOST, origin: ORIGIN, cookie } });
    expect(r.statusCode).toBe(403);
  });
  test('login token is single-use; CSP blocks remote images', async () => {
    const { app, loginToken } = await buildTestApp();
    const h = { host: HOST };
    const first = await app.inject({ url: `/login?t=${loginToken}`, headers: h });
    expect(first.statusCode).toBe(302);
    expect(first.headers['set-cookie']).toMatch(/HttpOnly.*SameSite=Strict/i);
    expect((await app.inject({ url: `/login?t=${loginToken}`, headers: h })).statusCode).toBe(401);
    expect(first.headers['content-security-policy']).toContain("img-src 'self' data:");
  });
  test('api requires session', async () => {
    const { app } = await buildTestApp();
    expect((await app.inject({ url: '/api/sessions', headers: { host: HOST } })).statusCode).toBe(401);
  });
});

describe('guards and session, edge cases', () => {
  test('missing Host and POST without Origin are rejected', async () => {
    const { app, authed } = await buildTestApp({ loggedIn: true });
    expect((await app.inject({ url: '/api/health', headers: { host: '' } })).statusCode).toBe(403);
    const noOrigin = authed({ method: 'DELETE', url: '/api/health' });
    delete (noOrigin.headers as Record<string, string>).origin;
    expect((await app.inject(noOrigin)).statusCode).toBe(403);
  });
  test('dev hosts are refused unless dev is on', async () => {
    const { app } = await buildTestApp();
    expect((await app.inject({ url: '/login', headers: { host: 'localhost:5173' } })).statusCode).toBe(403);
  });
  test('a logged-in, same-origin request reaches the route', async () => {
    const { app, authed } = await buildTestApp({ loggedIn: true });
    const r = await app.inject(authed({ url: '/api/health' }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect((await app.inject(authed({ method: 'POST', url: '/api/nope' }))).statusCode).toBe(404);
  });
  test('forged, expired or missing cookies get 401', async () => {
    const { app, db, authed, cookie } = await buildTestApp({ loggedIn: true });
    expect((await app.inject(authed({ url: '/api/health', headers: { cookie: `aos_session=${'A'.repeat(43)}` } }))).statusCode).toBe(401);
    db.prepare("UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await app.inject(authed({ url: '/api/health', headers: { cookie } }))).statusCode).toBe(401);
  });
  test('expired, malformed and repeated login tokens are refused and audited', async () => {
    const { app, db, loginToken } = await buildTestApp();
    db.prepare("UPDATE login_tokens SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const h = { host: HOST };
    expect((await app.inject({ url: `/login?t=${loginToken}`, headers: h })).statusCode).toBe(401);
    expect((await app.inject({ url: "/login?t=' OR 1=1--", headers: h })).statusCode).toBe(401);
    const t = createLoginToken(db);
    expect((await app.inject({ url: `/login?t=${t}&t=${t}`, headers: h })).statusCode).toBe(401);
    expect((await app.inject({ url: `/login?t=${t}`, headers: h })).statusCode).toBe(302);
    const rows = db.prepare("SELECT decision, args_redacted FROM audit_log WHERE action = 'auth.login'").all();
    expect(rows.map((r) => (r as { decision: string }).decision)).toEqual(['failure', 'failure', 'failure', 'success']);
    expect(JSON.stringify(rows)).not.toContain(t);
  });
  test('the session survives in the db (restart) and only its hash is stored', async () => {
    const { db, cookie } = await buildTestApp({ loggedIn: true });
    const token = cookie.split('=')[1] ?? '';
    const stored = db.prepare('SELECT token_hash FROM auth_sessions').all() as { token_hash: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]?.token_hash).not.toBe(token);
  });
});

describe('logger redaction', () => {
  test('tokens, keys and the login query never reach the log', async () => {
    let out = '';
    const stream = new Writable({ write: (chunk, _enc, cb) => ((out += String(chunk)), cb()) });
    const { app, authed, loginToken } = await buildTestApp({
      loggedIn: true,
      logger: { ...loggerOptions, stream },
      plugins: [
        async (api) => {
          api.get('/leak', async (req) => {
            req.log.info({ token: 'tok-secret', cfg: { apiKey: 'key-secret' }, headers: { authorization: 'Bearer auth-secret' } });
            return {};
          });
        },
      ],
    });
    await app.inject(authed({ url: '/api/leak', headers: { 'x-api-key': 'hdr-secret' } }));
    await app.inject({ url: `/login?t=${loginToken}`, headers: { host: HOST } });
    expect(out).toContain('/login');
    for (const secret of ['tok-secret', 'key-secret', 'auth-secret', 'hdr-secret', loginToken]) expect(out).not.toContain(secret);
  });
});
