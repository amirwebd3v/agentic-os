import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { GmailError } from './gmail.ts';

// Desktop-app OAuth: system browser, a random 127.0.0.1 port, PKCE S256 and a checked `state`.
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export interface OAuthClient {
  generateCodeVerifierAsync(): Promise<{ codeVerifier: string; codeChallenge?: string }>;
  generateAuthUrl(opts: Record<string, unknown>): string;
  getToken(opts: { code: string; codeVerifier: string; redirect_uri: string }): Promise<{ tokens: { access_token?: string | null; refresh_token?: string | null; scope?: string | null } }>;
  revokeToken(token: string): Promise<unknown>;
}

export const googleClient = (clientId: string, clientSecret: string): OAuthClient => {
  const client = new OAuth2Client({ clientId, clientSecret });
  return {
    generateCodeVerifierAsync: () => client.generateCodeVerifierAsync(),
    generateAuthUrl: (opts) => client.generateAuthUrl({ ...opts, code_challenge_method: CodeChallengeMethod.S256 }),
    getToken: async ({ code, codeVerifier, redirect_uri }) => client.getToken({ code, codeVerifier, redirect_uri }),
    revokeToken: (token) => client.revokeToken(token),
  };
};

/** A short-lived access token from a stored refresh token. A dead grant is `auth`, so the account asks for a reconnect. */
export function accessTokenSource(clientId: string, clientSecret: string, refreshToken: string): () => Promise<string> {
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials({ refresh_token: refreshToken });
  return async () => {
    try {
      const { token } = await client.getAccessToken();
      if (!token) throw new GmailError('auth');
      return token;
    } catch (err) {
      throw err instanceof GmailError ? err : tokenError(err);
    }
  };
}

/** No answer or a 5xx may pass, so it retries. Any other refusal won't, so it asks the owner instead of looping. */
export function tokenError(err: unknown): GmailError {
  const response = (err as { response?: { status?: number; data?: { error?: unknown } } }).response;
  if (!response?.status || response.status >= 500) return new GmailError('network');
  return new GmailError('auth', response.data?.error === 'deleted_client' ? 'deleted_client' : response.data?.error === 'invalid_client' ? 'invalid_client' : 'reconnect');
}

export type ConsentResult =
  | { status: 'granted'; accessToken: string; refreshToken: string }
  | { status: 'cancelled' | 'wrong_scope' | 'failed' | 'timed_out' };

/**
 * True when the token no longer works: revoked now, or Google says it was already invalid (400). False when Google
 * couldn't be reached in time. The error is dropped on purpose: its URL carries the token.
 */
export async function revoke(client: OAuthClient, token: string, timeoutMs = 10_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const call = client.revokeToken(token).then(
    () => true,
    (err: { status?: number; response?: { status?: number } }) => (err.status ?? err.response?.status) === 400,
  );
  return Promise.race([call, late]).finally(() => clearTimeout(timer));
}

const page = (text: string) => `<!doctype html><meta charset="utf-8"><title>Agentic OS</title><p>${text}</p>`;

/** The scope must be exactly read-only: anything wider is revoked and refused. */
async function exchange(client: OAuthClient, code: string, codeVerifier: string, redirect_uri: string): Promise<ConsentResult> {
  const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri });
  const held = tokens.refresh_token ?? tokens.access_token;
  if (tokens.scope?.trim() !== GMAIL_SCOPE) {
    if (held) await revoke(client, held);
    return { status: 'wrong_scope' };
  }
  if (!tokens.access_token || !tokens.refresh_token) return { status: 'failed' };
  return { status: 'granted', accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

export interface ConsentFlow {
  url: string;
  /** Ends the wait: reports `cancelled` and frees the port. */
  cancel(): void;
}

/** Browsers refuse the same low "unsafe" ports fetch does (4190, 6667…), and Windows hands out ephemeral ports that low. */
async function listenOnSafePort(): Promise<{ server: Server; redirect: string }> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    if (port > 10080) return { server, redirect: `http://127.0.0.1:${port}` };
    server.close();
  }
}

/** Starts the local listener and returns the URL for the browser. `done` is called exactly once. */
export async function startConsent(client: OAuthClient, done: (result: ConsentResult) => void, timeoutMs = 5 * 60_000): Promise<ConsentFlow> {
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomBytes(32).toString('base64url');
  const { server, redirect } = await listenOnSafePort();
  let finished = false;
  let exchanging = false;
  const finish = (result: ConsentResult) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    server.close();
    server.closeIdleConnections();
    done(result);
  };
  const timer = setTimeout(() => finish({ status: 'timed_out' }), timeoutMs);
  timer.unref();

  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', redirect);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // A stray request, or one without our state, ends nothing: only Google's redirect may finish the flow.
    if (req.method !== 'GET' || url.pathname !== '/' || url.searchParams.get('state') !== state) {
      res.writeHead(400).end(page('This is not the request Agentic OS is waiting for.'));
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      res.end(page('Nothing was connected. You can close this tab.'));
      finish({ status: 'cancelled' });
      return;
    }
    res.end(page('Done. You can close this tab and go back to Agentic OS.'));
    if (exchanging) return; // a browser retry: Google would refuse the reused code and fail a good connect
    exchanging = true;
    exchange(client, code, codeVerifier, redirect).then(
      (result) => {
        // Cancelled or timed out meanwhile: nobody will store this token, so it must not stay valid at Google.
        if (finished && result.status === 'granted') void revoke(client, result.refreshToken);
        finish(result);
      },
      () => finish({ status: 'failed' }),
    );
  });

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // Google only returns a refresh token on a fresh consent
    scope: [GMAIL_SCOPE],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    redirect_uri: redirect,
  });
  return { url, cancel: () => finish({ status: 'cancelled' }) };
}
