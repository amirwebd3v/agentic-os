import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, needsLogin, streamMessage } from '../src/api';

const sse = (chunks: string[], status = 200) =>
  new Response(new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  }), { status, headers: { 'content-type': 'text/event-stream' } });

afterEach(() => vi.unstubAllGlobals());

test('streamMessage follows the contract event order across split chunks', async () => {
  const fetch = vi.fn(async () => sse([
    'data: {"user_message_id":1,"assistant_message_id":2}\n\nda',
    'ta: {"delta":"Hel"}\n\ndata: {"delta":"lo"}\n',
    '\ndata: {"done":true,"usage":{"input_tokens":1,"output_tokens":2,"cache_read_tokens":0}}\n\n',
  ]));
  vi.stubGlobal('fetch', fetch);
  const ids = vi.fn();
  let text = '';
  const end = await streamMessage(7, 'hi', { start: ids, delta: (d) => (text += d) }, new AbortController().signal);
  expect(end).toEqual({ kind: 'done' });
  expect(text).toBe('Hello');
  expect(ids).toHaveBeenCalledWith({ user_message_id: 1, assistant_message_id: 2 });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/sessions/7/messages');
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"content":"hi"}' });
  expect(init.headers).toMatchObject({ 'X-AOS': '1' });
});

test('an error event and a stream cut short both end as errors', async () => {
  const noop = { start() {}, delta() {} };
  vi.stubGlobal('fetch', async () => sse(['data: {"error":{"kind":"rate_limit"}}\n\n']));
  expect(await streamMessage(1, 'x', noop, new AbortController().signal)).toEqual({ kind: 'error', error: 'rate_limit' });
  vi.stubGlobal('fetch', async () => sse(['data: {"delta":"par"}\n\n']));
  expect(await streamMessage(1, 'x', noop, new AbortController().signal)).toEqual({ kind: 'error', error: 'network' });
});

test('aborting resolves as aborted', async () => {
  const ctrl = new AbortController();
  vi.stubGlobal('fetch', async (_u: string, init: RequestInit) =>
    new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"delta":"a"}\n\n'));
        init.signal!.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
      },
    })));
  const p = streamMessage(1, 'x', { start() {}, delta: () => ctrl.abort() }, ctrl.signal);
  expect(await p).toEqual({ kind: 'aborted' });
});

test('409 throws ApiError and 401 flags the login prompt', async () => {
  const noop = { start() {}, delta() {} };
  vi.stubGlobal('fetch', async () => Response.json({ error: 'provider_not_configured' }, { status: 409 }));
  await expect(streamMessage(1, 'x', noop, new AbortController().signal)).rejects.toBeInstanceOf(ApiError);
  vi.stubGlobal('fetch', async () => Response.json({ error: 'not logged in' }, { status: 401 }));
  await expect(streamMessage(1, 'x', noop, new AbortController().signal)).rejects.toMatchObject({ status: 401 });
  expect(needsLogin.value).toBe(true);
});
