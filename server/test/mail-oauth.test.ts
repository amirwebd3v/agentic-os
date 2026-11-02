import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { emailRoutes } from '../src/http/routes/email.ts';
import type { EmailDeps } from '../src/http/routes/email.ts';
import { createGmail, GmailError } from '../src/mail/gmail.ts';
import { GMAIL_SCOPE, revoke, startConsent } from '../src/mail/oauth.ts';
import type { ConsentResult, OAuthClient } from '../src/mail/oauth.ts';
import { buildTestApp } from './helpers.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A fake Gmail. Listens above 10080 because fetch refuses lower "bad ports". Records every path it is asked for. */
async function fakeGmail(email: () => string, status = 200) {
  const seen: string[] = [];
  for (;;) {
    const srv = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(status === 200 ? { emailAddress: email(), historyId: '1' } : {}));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    const { port } = srv.address() as AddressInfo;
    if (port > 10080) return { base: `http://127.0.0.1:${port}`, seen };
  }
}

function fakeClient(tokens: Partial<{ access_token: string | null; refresh_token: string | null; scope: string }> = {}) {
  const revoked: string[] = [];
  const opts: Record<string, unknown>[] = [];
  const client: OAuthClient = {
    generateCodeVerifierAsync: async () => ({ codeVerifier: 'v', codeChallenge: 'c' }),
    generateAuthUrl: (o) => {
      opts.push(o);
      return `https://accounts.example/auth?state=${String(o['state'])}&redirect=${encodeURIComponent(String(o['redirect_uri']))}`;
    },
    getToken: async () => ({ tokens: { access_token: 'at', refresh_token: 'rt', scope: GMAIL_SCOPE, ...tokens } }),
    revokeToken: async (t) => {
      revoked.push(t);
      return {};
    },
  };
  return { client, revoked, opts };
}

const memoryTokens = () => {
  const m = new Map<number, string>();
  return { m, store: { get: (id: number) => m.get(id) ?? null, set: (id: number, t: string) => void m.set(id, t), delete: (id: number) => void m.delete(id) } };
};
const parts = (url: string) => {
  const u = new URL(url);
  return { state: u.searchParams.get('state')!, redirect: u.searchParams.get('redirect')! };
};

describe('consent flow', () => {
  const start = async (client: OAuthClient, timeout?: number) => {
    let result: ConsentResult | undefined;
    const flow = await startConsent(client, (r) => (result = r), timeout);
    return { flow, ...parts(flow.url), result: () => result };
  };

  test('asks offline, read-only, PKCE, and listens on a loopback port fetch and browsers accept', async () => {
    const { client, opts } = fakeClient();
    const { flow, redirect } = await start(client);
    expect(opts[0]).toMatchObject({ access_type: 'offline', prompt: 'consent', scope: [GMAIL_SCOPE], code_challenge: 'c', code_challenge_method: 'S256' });
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(Number(new URL(redirect).port)).toBeGreaterThan(10080);
    flow.cancel();
  });

  test('a wrong state is refused and the flow keeps waiting', async () => {
    const { flow, redirect, state, result } = await start(fakeClient().client);
    expect((await fetch(`${redirect}/?state=wrong&code=x`)).status).toBe(400);
    expect(result()).toBeUndefined();
    await fetch(`${redirect}/?state=${state}&code=x`);
    await vi.waitFor(() => expect(result()).toMatchObject({ status: 'granted', refreshToken: 'rt' }));
    flow.cancel();
  });

  test('declining at Google is cancelled', async () => {
    const { redirect, state, result } = await start(fakeClient().client);
    await fetch(`${redirect}/?state=${state}&error=access_denied`);
    await vi.waitFor(() => expect(result()).toEqual({ status: 'cancelled' }));
  });

  test.each(['https://www.googleapis.com/auth/gmail.modify', `${GMAIL_SCOPE} https://www.googleapis.com/auth/gmail.send`, ''])('a scope other than exactly read-only is revoked and refused: "%s"', async (scope) => {
    const { client, revoked } = fakeClient({ scope });
    const { redirect, state, result } = await start(client);
    await fetch(`${redirect}/?state=${state}&code=x`);
    await vi.waitFor(() => expect(result()).toEqual({ status: 'wrong_scope' }));
    expect(revoked).toEqual(['rt']);
  });

  test('no refresh token, a failed exchange and a timeout each end the flow', async () => {
    const none = await start(fakeClient({ refresh_token: null }).client);
    await fetch(`${none.redirect}/?state=${none.state}&code=x`);
    await vi.waitFor(() => expect(none.result()).toEqual({ status: 'failed', reason: 'no_refresh_token' }));

    const bad = { ...fakeClient().client, getToken: async () => Promise.reject(new Error('nope')) };
    const failed = await start(bad);
    await fetch(`${failed.redirect}/?state=${failed.state}&code=x`);
    await vi.waitFor(() => expect(failed.result()).toEqual({ status: 'failed', reason: 'exchange:unknown' }));

    const late = await start(fakeClient().client, 10);
    await vi.waitFor(() => expect(late.result()).toEqual({ status: 'timed_out' }));
  });
});

describe('tokens nobody will hold are revoked', () => {
  test('a cancel while the code is being exchanged', async () => {
    const { client, revoked } = fakeClient();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const getToken = client.getToken.bind(client);
    client.getToken = async (o) => {
      await gate;
      return getToken(o);
    };
    let result: ConsentResult | undefined;
    const flow = await startConsent(client, (r) => (result = r));
    const { redirect, state } = parts(flow.url);
    await fetch(`${redirect}/?state=${state}&code=x`);
    flow.cancel();
    expect(result).toEqual({ status: 'cancelled' });
    release();
    await vi.waitFor(() => expect(revoked).toEqual(['rt']));
  });

  test('a browser retry does not exchange the code twice', async () => {
    const { client } = fakeClient();
    const getToken = vi.spyOn(client, 'getToken');
    const flow = await startConsent(client, () => {});
    const { redirect, state } = parts(flow.url);
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    getToken.mockImplementationOnce(async () => {
      await gate;
      return { tokens: { access_token: 'at', refresh_token: 'rt', scope: GMAIL_SCOPE } };
    });
    await fetch(`${redirect}/?state=${state}&code=x`);
    await fetch(`${redirect}/?state=${state}&code=x`);
    release();
    await vi.waitFor(() => expect(getToken).toHaveBeenCalledTimes(1));
  });

  test('revoke: an already invalid token counts, a hang does not', async () => {
    const { client } = fakeClient();
    client.revokeToken = async () => Promise.reject(Object.assign(new Error('x'), { status: 400 }));
    expect(await revoke(client, 't')).toBe(true);
    client.revokeToken = async () => Promise.reject(new Error('offline'));
    expect(await revoke(client, 't')).toBe(false);
    client.revokeToken = () => new Promise(() => {});
    expect(await revoke(client, 't', 10)).toBe(false);
  });
});

describe('accounts routes', () => {
  async function setup(over: Partial<EmailDeps> & { emails?: string[] } = {}) {
    const emails = [...(over.emails ?? ['a@example.com'])];
    const gmail = await fakeGmail(() => emails.shift() ?? 'last@example.com');
    const fake = fakeClient();
    const tokens = memoryTokens();
    const t = await buildTestApp({ loggedIn: true, plugins: [emailRoutes({ client: () => fake.client, tokens: tokens.store, gmailBase: gmail.base, ...over })] });
    const get = async () => (await t.app.inject(t.authed({ method: 'GET', url: '/api/email/accounts' }))).json();
    const connect = async () => {
      const { url } = (await t.app.inject(t.authed({ method: 'POST', url: '/api/email/accounts/connect' }))).json();
      const { redirect, state } = parts(url);
      await fetch(`${redirect}/?state=${state}&code=x`);
      await vi.waitFor(async () => expect((await get()).flow).toBe('connected'));
    };
    return { ...t, get, connect, gmail, fake, tokens };
  }

  test('without the Google client it says so and refuses to start', async () => {
    const t = await setup({ client: () => null });
    expect(await t.get()).toEqual({ setup: false, flow: 'idle', reason: null, accounts: [] });
    const res = await t.app.inject(t.authed({ method: 'POST', url: '/api/email/accounts/connect' }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'gmail_not_set_up' });
  });

  test('connects two accounts, reads only the profile, and never returns a token', async () => {
    const t = await setup({ emails: ['a@example.com', 'b@example.com'] });
    await t.connect();
    await t.connect();
    const out = await t.get();
    expect(out.accounts.map((a: { email: string }) => a.email)).toEqual(['a@example.com', 'b@example.com']);
    expect(t.gmail.seen).toEqual(['GET /profile', 'GET /profile']);
    expect(t.db.prepare(`SELECT count(*) FROM jobs WHERE kind = 'mail_sync'`).pluck().get()).toBe(2); // first sync starts at once
    expect([...t.tokens.m.values()]).toEqual(['rt', 'rt']);
    expect(JSON.stringify(out)).not.toContain('rt"');
  });

  test('the same account twice updates it, and a reconnect clears its state', async () => {
    const t = await setup({ emails: ['a@example.com', 'a@example.com'] });
    await t.connect();
    t.db.prepare(`UPDATE mail_accounts SET status = 'reconnect'`).run();
    await t.connect();
    expect((await t.get()).accounts).toMatchObject([{ email: 'a@example.com', status: 'connected' }]);
  });

  test('a profile failure stores nothing and revokes the token', async () => {
    const gmail = await fakeGmail(() => '', 500);
    const t = await setup({ gmailBase: gmail.base });
    const { url } = (await t.app.inject(t.authed({ method: 'POST', url: '/api/email/accounts/connect' }))).json();
    const { redirect, state } = parts(url);
    await fetch(`${redirect}/?state=${state}&code=x`);
    await vi.waitFor(async () => expect((await t.get()).flow).toBe('failed'));
    expect((await t.get()).accounts).toEqual([]);
    expect((await t.get()).reason).toBe('profile:server');
    expect(t.fake.revoked).toEqual(['rt']);
    expect(t.tokens.m.size).toBe(0);
  });

  test("Gmail API not enabled: the reason carries Google's code and is kept in the database", async () => {
    const srv = createServer((_req, res) => res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { errors: [{ reason: 'accessNotConfigured' }] } })));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    const port = (srv.address() as AddressInfo).port;
    if (port <= 10080) return; // fetch's bad ports: covered by the other profile test
    const t = await setup({ gmailBase: `http://127.0.0.1:${port}` });
    const { url } = (await t.app.inject(t.authed({ method: 'POST', url: '/api/email/accounts/connect' }))).json();
    await fetch(`${parts(url).redirect}/?state=${parts(url).state}&code=x`);
    await vi.waitFor(async () => expect((await t.get()).reason).toBe('profile:bad_request:accessNotConfigured'));
    expect(JSON.parse(t.db.prepare(`SELECT value FROM mail_settings WHERE key = 'connect_error'`).pluck().get() as string)).toMatchObject({ code: 'profile:bad_request:accessNotConfigured' });
  });

  test("a refused exchange records Google's error code, never its message", async () => {
    const fake = fakeClient();
    fake.client.getToken = async () => Promise.reject(Object.assign(new Error('secret detail'), { response: { data: { error: 'redirect_uri_mismatch', error_description: 'secret detail' } } }));
    const t = await setup({ client: () => fake.client });
    const { url } = (await t.app.inject(t.authed({ method: 'POST', url: '/api/email/accounts/connect' }))).json();
    await fetch(`${parts(url).redirect}/?state=${parts(url).state}&code=x`);
    await vi.waitFor(async () => expect((await t.get()).reason).toBe('exchange:redirect_uri_mismatch'));
    expect(JSON.stringify(await t.get())).not.toContain('secret detail');
  });

  test('a second click replaces the wait', async () => {
    const t = await setup();
    const first = (await t.app.inject(t.authed({ method: 'POST', url: '/api/email/accounts/connect' }))).json();
    const second = (await t.app.inject(t.authed({ method: 'POST', url: '/api/email/accounts/connect' }))).json();
    await expect(fetch(`${parts(first.url).redirect}/?state=${parts(first.url).state}&code=x`)).rejects.toThrow();
    expect((await t.get()).flow).toBe('waiting');
    await fetch(`${parts(second.url).redirect}/?state=${parts(second.url).state}&code=x`);
    await vi.waitFor(async () => expect((await t.get()).flow).toBe('connected'));
  });

  test('disconnect revokes and deletes the token; keep holds the rows, otherwise they go', async () => {
    const t = await setup({ emails: ['a@example.com', 'b@example.com'] });
    await t.connect();
    await t.connect();
    const insert = (accountId: number) => t.db.prepare(`INSERT INTO mail_messages (account_id, gmail_id, internal_date, state) VALUES (?, 'g', '2026-11-01', 'needs_sorting')`).run(accountId);
    insert(1);
    insert(2);
    const del = (id: number, keep: string) => t.app.inject(t.authed({ method: 'DELETE', url: `/api/email/accounts/${id}?keep=${keep}` }));
    expect((await del(1, '1')).json()).toEqual({ revoked: true });
    expect((await del(2, '0')).json()).toEqual({ revoked: true });
    expect(t.tokens.m.size).toBe(0);
    expect((await t.get()).accounts).toMatchObject([{ email: 'a@example.com', status: 'disconnected' }]);
    expect(t.db.prepare('SELECT account_id FROM mail_messages').pluck().all()).toEqual([1]);
    expect((await del(9, '0')).statusCode).toBe(404);
    expect((await del(1, 'x')).statusCode).toBe(400);
  });

  test('a reconnect revokes the token it replaces', async () => {
    const t = await setup({ emails: ['a@example.com', 'a@example.com'] });
    t.tokens.m.set(1, 'old');
    await t.connect();
    await vi.waitFor(() => expect(t.fake.revoked).toEqual(['old']));
    expect(t.tokens.m.get(1)).toBe('rt');
  });

  test('a Credential Manager failure leaves no connected row, and revokes the new token', async () => {
    const tokens = memoryTokens();
    const t = await setup({ tokens: { ...tokens.store, set: () => { throw new Error('keyring'); } } });
    const { url } = (await t.app.inject(t.authed({ method: 'POST', url: '/api/email/accounts/connect' }))).json();
    await fetch(`${parts(url).redirect}/?state=${parts(url).state}&code=x`);
    await vi.waitFor(async () => expect((await t.get()).flow).toBe('failed'));
    expect((await t.get()).accounts).toEqual([]);
    expect(t.fake.revoked).toEqual(['rt']);
  });

  test('a Credential Manager failure on disconnect is visible and keeps the account', async () => {
    const tokens = memoryTokens();
    const t = await setup({ tokens: { ...tokens.store, get: () => { throw new Error('keyring'); } } });
    t.db.prepare(`INSERT INTO mail_accounts (email) VALUES ('a@example.com')`).run();
    expect((await t.app.inject(t.authed({ method: 'DELETE', url: '/api/email/accounts/1?keep=0' }))).statusCode).toBe(500);
    expect((await t.get()).accounts).toHaveLength(1);
  });

  test('an offline revoke still removes the token and says it failed', async () => {
    const t = await setup();
    await t.connect();
    t.fake.client.revokeToken = async () => Promise.reject(new Error('offline'));
    const res = await t.app.inject(t.authed({ method: 'DELETE', url: '/api/email/accounts/1?keep=0' }));
    expect(res.json()).toEqual({ revoked: false });
    expect(t.tokens.m.size).toBe(0);
  });
});

describe('the Gmail client', () => {
  test('its source can only read', () => {
    const src = readFileSync(new URL('../src/mail/gmail.ts', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/method\s*:/);
    expect(src).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    expect(src).not.toMatch(/\/(send|modify|trash|untrash|batchModify|batchDelete|drafts|labels|settings|import|insert|watch|stop)\b/i);
    expect([...src.matchAll(/=> get</g)].length).toBe(4);
  });

  test('no other source file holds a Gmail URL or a wider scope', () => {
    const scope = readFileSync(new URL('../src/mail/oauth.ts', import.meta.url), 'utf8');
    expect([...scope.matchAll(/auth\/gmail\.\w+/g)].map((m) => m[0])).toEqual(['auth/gmail.readonly']);
  });

  test.each([
    [401, 'auth'],
    [404, 'not_found'],
    [429, 'rate'],
    [500, 'server'],
    [400, 'bad_request'],
  ])('HTTP %i is a fixed %s error with no body text', async (code, kind) => {
    const { base } = await fakeGmail(() => '', code);
    const err = await createGmail(async () => 't', base).getProfile().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GmailError);
    expect(err).toMatchObject({ kind, message: `gmail ${kind}` });
  });

  test('a token failure and a dead server are network errors, and the bearer is sent', async () => {
    await expect(createGmail(async () => Promise.reject(new Error('x')), 'http://127.0.0.1:1').getProfile()).rejects.toMatchObject({ kind: 'network' });
    await expect(createGmail(async () => 't', 'http://127.0.0.1:1').getProfile()).rejects.toMatchObject({ kind: 'network' });
  });
});
