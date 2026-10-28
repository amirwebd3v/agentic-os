import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { parseConfig } from '../src/config.ts';
import { providerRoutes } from '../src/http/routes/provider.ts';
import { getLlm, providerStatus, reloadLlm, stream, structured, systemBlocks } from '../src/llm/client.ts';
import { mapError } from '../src/llm/errors.ts';
import { buildTestApp, makeTestDb } from './helpers.ts';

const secret = vi.hoisted(() => ({ key: null as string | null }));
vi.mock('../src/secrets.ts', () => ({ getSecret: () => secret.key }));

// The SDK is real; only fetch is faked, so no test touches the network.
const config = parseConfig({ vaultDir: resolve('/aos-test/vault'), dataDir: resolve('/aos-test/data'), llm: { baseURL: 'http://router.test:20128' } });
let db: ReturnType<typeof makeTestDb>;
let requests: { url: string; body: Record<string, unknown> }[];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'retry-after-ms': '0' } });
const message = (text: string) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn', stop_sequence: null,
  content: [{ type: 'text', text }],
  usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
});
const sse = (...events: object[]) =>
  new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

function fakeFetch(...responses: (() => Response)[]) {
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  });
}

const rows = () => db.prepare('SELECT pipeline, model, input_tokens, output_tokens, cache_read_tokens, error FROM llm_calls').all();

beforeEach(() => {
  db = makeTestDb();
  requests = [];
  secret.key = 'sk-test';
  reloadLlm();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('no key → null client, not_configured, calls fail as auth and are recorded', async () => {
  secret.key = null;
  expect(getLlm(config)).toBeNull();
  expect(providerStatus(config).status).toBe('not_configured');
  await expect(structured({ db, config }, { pipeline: 'p', tier: 'fast', input: 'x', schema: z.object({}) })).rejects.toMatchObject({ kind: 'auth' });
  expect(rows()).toHaveLength(1);
});

test('inherited ANTHROPIC_AUTH_TOKEN is never used', () => {
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'claude-code-token');
  const client = getLlm(config)!;
  expect(client.authToken).toBeNull();
  expect(client.apiKey).toBe('sk-test');
});

test('error mapping', () => {
  expect(mapError({ status: 401 }).kind).toBe('auth');
  expect(mapError({ status: 403 }).kind).toBe('auth');
  expect(mapError({ status: 429 }).kind).toBe('rate_limit');
  expect(mapError({ status: 529 }).kind).toBe('overloaded');
  expect(mapError({ status: 400 }).kind).toBe('bad_request');
  expect(mapError(new TypeError('fetch failed')).kind).toBe('network');
});

test('local errors never carry model text into messages, the ledger or logs', () => {
  const leak = new SyntaxError('Unexpected end of JSON input near "my therapist said I should"');
  const e = mapError(leak);
  expect(e.kind).toBe('network');
  expect(e.message).toBe('SyntaxError (no response from provider)');
  expect(e.cause).toBeUndefined();
  expect(mapError(Object.assign(new Error('x'.repeat(1000)), { status: 400 })).message).toHaveLength(300);
});

test('system blocks: rules and persona cached, context last and uncached', () => {
  expect(systemBlocks({ context: 'c', persona: 'p', rules: 'r' })).toEqual([
    { type: 'text', text: 'r', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'p', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'c' },
  ]);
});

test('structured: config baseURL and tier model, inherited ANTHROPIC_BASE_URL ignored, parsed and recorded', async () => {
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://claude-code-proxy.invalid');
  fakeFetch(() => json(200, message('{"answer":"hi"}')));
  const out = await structured({ db, config }, {
    pipeline: 'triage', tier: 'work', system: { rules: 'r', context: 'c' }, input: 'q', schema: z.object({ answer: z.string() }),
  });
  expect(out).toEqual({ answer: 'hi' });
  expect(requests[0]!.url).toBe('http://router.test:20128/v1/messages');
  expect(requests[0]!.body).toMatchObject({ model: config.llm.models.work, output_config: { format: { type: 'json_schema' } } });
  expect(rows()).toEqual([{ pipeline: 'triage', model: config.llm.models.work, input_tokens: 11, output_tokens: 7, cache_read_tokens: 5, error: null }]);
});

test('retries rate_limit and overloaded, then succeeds; one ledger row', async () => {
  fakeFetch(
    () => json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
    () => json(529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
    () => json(200, message('{}')),
  );
  await structured({ db, config }, { pipeline: 'p', tier: 'fast', input: 'x', schema: z.object({}) });
  expect(requests).toHaveLength(3);
  expect(rows()).toHaveLength(1);
});

test('bad_request is not retried and is recorded with its error', async () => {
  fakeFetch(() => json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } }));
  await expect(structured({ db, config }, { pipeline: 'p', tier: 'deep', input: 'x', schema: z.object({}) })).rejects.toMatchObject({ kind: 'bad_request' });
  expect(requests).toHaveLength(1);
  expect(rows()).toEqual([expect.objectContaining({ model: config.llm.models.deep, error: expect.stringMatching(/^bad_request: /) })]);
});

test('auth failure flips provider status to error until reload', async () => {
  fakeFetch(() => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  await expect(structured({ db, config }, { pipeline: 'p', tier: 'fast', input: 'x', schema: z.object({}) })).rejects.toMatchObject({ kind: 'auth' });
  expect(providerStatus(config).status).toBe('error');
  reloadLlm();
  expect(providerStatus(config).status).toBe('ok');
});

const streamBody = () =>
  sse(
    { type: 'message_start', message: { ...message(''), content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  );

test('stream yields text deltas then usage, and records the call', async () => {
  fakeFetch(streamBody);
  const events = [];
  for await (const ev of stream({ db, config }, { pipeline: 'chat', tier: 'work', messages: [{ role: 'user', content: 'hi' }] })) events.push(ev);
  expect(events.filter((e) => e.type === 'text').map((e) => e.text).join('')).toBe('Hello');
  expect(events.at(-1)).toMatchObject({ type: 'done', usage: { input_tokens: 3, output_tokens: 2 } });
  expect(requests[0]!.body).toMatchObject({ stream: true });
  expect(rows()).toEqual([expect.objectContaining({ pipeline: 'chat', input_tokens: 3, output_tokens: 2, error: null })]);
});

test('stream stopped early by the consumer is still recorded', async () => {
  fakeFetch(streamBody);
  for await (const ev of stream({ db, config }, { pipeline: 'chat', tier: 'work', messages: [{ role: 'user', content: 'hi' }] })) {
    if (ev.type === 'text') break;
  }
  expect(rows()).toEqual([expect.objectContaining({ error: expect.stringMatching(/^aborted: /) })]);
});

test('provider routes under /api, behind the session check', async () => {
  const { app, authed } = await buildTestApp({ loggedIn: true, plugins: [providerRoutes] });
  secret.key = null;
  expect((await app.inject(authed({ method: 'GET', url: '/api/provider' }))).json()).toEqual({
    status: 'not_configured', baseURL: app.config.llm.baseURL, models: app.config.llm.models,
  });
  secret.key = 'sk-test';
  expect((await app.inject(authed({ method: 'POST', url: '/api/provider/reload' }))).json()).toMatchObject({ status: 'ok' });
  expect((await app.inject(authed({ method: 'GET', url: '/api/provider', headers: { cookie: '' } }))).statusCode).toBe(401);
  await app.close();
});
