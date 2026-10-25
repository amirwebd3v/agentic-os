---
id: W1-04
title: "Fastify server, hardening, token login"
epic: AOS-W1
status: Backlog
points: 3
wave: 3
risk: Medium
depends_on:
  - "[[W1-02-database]]"
  - "[[W1-03-secrets]]"
skills:
  - secure-code-guardian
  - fullstack-guardian
started:
completed:
---

# W1-04 — Fastify server with local hardening and token login

**Points:** 3 · **Risk:** Medium (security-critical) · **Depends on:** W1-02, W1-03 · **Skill/agent:** `secure-code-guardian`, `fullstack-guardian`
Overview: [plan-review.md M9, M10](../../plan-review.md) · Plan: [implementation-plan.md](../implementation-plan.md)

## Summary
The server binds to `127.0.0.1` only and rejects foreign `Host` and `Origin` headers. Login works the way Jupyter does: a one-time URL printed to the terminal is exchanged for a session cookie. State-changing requests need a custom header, and every response carries a strict CSP. Together these defeat CSRF, DNS rebinding, and remote-image exfiltration.

## Implementation steps
1. **`server/src/app.ts`:** `buildApp(deps)` returns a Fastify instance, so it's testable with `inject`. **`server/src/main.ts`** calls `listen({ host: '127.0.0.1', port })`.
2. **Host check** (`onRequest` hook): allowed hosts are `127.0.0.1:<port>` and `localhost:<port>`, plus `127.0.0.1:5173` and `localhost:5173` in dev. Anything else gets **403**.
3. **Origin check:** for every non-GET request, `Origin` must be in the allowed set. A missing `Origin` on a non-GET request gets 403. On top of that, state-changing routes require `X-AOS: 1`; a cross-origin page can't send that header without a CORS preflight, which we never grant.
4. **Login:**
   - At boot, print `Open http://127.0.0.1:3000/login?t=<token>`, where the token is 32 random bytes, valid 10 minutes, single use.
   - `GET /login?t=` checks the token, then creates an `auth_sessions` row storing only the token's **sha256**, valid 30 days.
   - It sets the cookie `aos_session` with `HttpOnly; SameSite=Strict; Path=/`, then redirects to `/`.
   - Every `/api/*` request requires a valid session.
   - `pnpm login-url` prints a new token if you lose the terminal.
5. **Security headers** (`onSend`), on every response:
   ```
   Content-Security-Policy: default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self';
     style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'
   X-Content-Type-Options: nosniff
   Referrer-Policy: no-referrer
   Cross-Origin-Opener-Policy: same-origin
   ```
6. **Static:** serve `web/dist` with `@fastify/static` in production. In dev, Vite proxies `/api` to the server.
7. **Audit:** log login success and failure.
8. **Firewall (manual, admin, you run it):** documented in README:
   `New-NetFirewallRule -DisplayName "AgenticOS block inbound" -Direction Inbound -LocalPort 3000,8009 -Protocol TCP -Action Block`

## Files
| File | Action |
|---|---|
| `server/src/app.ts`, `server/src/main.ts`, `server/src/http/{guards,auth,headers}.ts` | Create |
| `server/test/security.test.ts` | Create |

## Tests — `server/test/security.test.ts`
```ts
import { describe, test, expect } from 'vitest';
import { buildTestApp } from './helpers';   // in-memory db, port 3000, returns { app, loginToken }

describe('local hardening', () => {
  test('foreign Host is rejected (DNS rebinding)', async () => {
    const { app } = await buildTestApp();
    const r = await app.inject({ url: '/api/health', headers: { host: 'evil.example:3000' } });
    expect(r.statusCode).toBe(403);
  });
  test('cross-origin POST is rejected', async () => {
    const { app, cookie } = await buildTestApp({ loggedIn: true });
    const r = await app.inject({ method: 'POST', url: '/api/sessions',
      headers: { host: '127.0.0.1:3000', origin: 'https://evil.example', cookie, 'x-aos': '1' } });
    expect(r.statusCode).toBe(403);
  });
  test('POST without X-AOS is rejected', async () => {
    const { app, cookie } = await buildTestApp({ loggedIn: true });
    const r = await app.inject({ method: 'POST', url: '/api/sessions',
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', cookie } });
    expect(r.statusCode).toBe(403);
  });
  test('login token is single-use; CSP blocks remote images', async () => {
    const { app, loginToken } = await buildTestApp();
    const h = { host: '127.0.0.1:3000' };
    const first = await app.inject({ url: `/login?t=${loginToken}`, headers: h });
    expect(first.statusCode).toBe(302);
    expect(first.headers['set-cookie']).toMatch(/HttpOnly.*SameSite=Strict/i);
    expect((await app.inject({ url: `/login?t=${loginToken}`, headers: h })).statusCode).toBe(401);
    expect(first.headers['content-security-policy']).toContain("img-src 'self' data:");
  });
  test('api requires session', async () => {
    const { app } = await buildTestApp();
    expect((await app.inject({ url: '/api/sessions', headers: { host: '127.0.0.1:3000' } })).statusCode).toBe(401);
  });
});
```

## Acceptance criteria
- [ ] Every test above passes.
- [ ] `netstat -ano | findstr :3000` shows only `127.0.0.1:3000`.
- [ ] Opening the printed URL logs you in, and the cookie survives restarts until it expires.
