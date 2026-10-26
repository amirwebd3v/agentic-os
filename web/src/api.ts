import { ref } from 'vue';

// Shapes from docs/week1/api-contract.md.
export type Area = {
  id: number; slug: string; name: string; parent_id: number | null;
  status: 'active' | 'proposed'; mode: 'do' | 'explain' | 'tutor';
};
export type FilingStatus = 'auto' | 'flagged' | 'inbox' | 'user';
export type SessionMode = 'chat' | 'persona';
export type SessionSummary = {
  id: number; title: string | null; mode: SessionMode;
  area_id: number | null; area_slug: string | null;
  filing_status: FilingStatus | null; area_confidence: number | null;
  started_at: string; last_message_at: string | null;
};
export type Message = {
  id: number; role: 'user' | 'assistant'; content: string;
  status: 'streaming' | 'done' | 'aborted' | 'error'; created_at: string;
};
export type Provider = {
  status: 'ok' | 'not_configured' | 'error'; baseURL: string;
  models: { fast: string; work: string; deep: string };
};
export type StreamErrorKind = 'auth' | 'rate_limit' | 'overloaded' | 'bad_request' | 'network';
export type StreamEnd = { kind: 'done' } | { kind: 'aborted' } | { kind: 'error'; error: StreamErrorKind };

/** Set when any call gets 401; the app then shows how to log in. */
export const needsLogin = ref(false);

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { 'X-AOS': '1' } : { 'X-AOS': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
    signal: signal ?? null,
  });
  if (res.status === 401) needsLogin.value = true;
  if (!res.ok) throw new ApiError(res.status);
  return res;
}
const json = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
  (await call(method, path, body)).json() as Promise<T>;

export const getProvider = () => json<Provider>('GET', '/api/provider');
export const reloadProvider = () => json<Provider>('POST', '/api/provider/reload');
export const listAreas = () => json<Area[]>('GET', '/api/areas');
export const listSessions = () => json<SessionSummary[]>('GET', '/api/sessions');
export const createSession = (mode: SessionMode) => json<SessionSummary>('POST', '/api/sessions', { mode });
export const getSession = (id: number) =>
  json<{ session: SessionSummary; messages: Message[] }>('GET', `/api/sessions/${id}`);
export const patchSession = (id: number, patch: { title?: string; area_id?: number }) =>
  json<SessionSummary>('PATCH', `/api/sessions/${id}`, patch);

type StreamHandlers = {
  start(ids: { user_message_id: number; assistant_message_id: number }): void;
  delta(text: string): void;
};

/**
 * POSTs a message and reads the SSE reply (fetch + ReadableStream; EventSource can't POST).
 * Resolves with how the stream ended; HTTP errors (e.g. 409 provider_not_configured) throw ApiError.
 */
export async function streamMessage(
  sessionId: number, content: string, on: StreamHandlers, signal: AbortSignal,
): Promise<StreamEnd> {
  try {
    const res = await call('POST', `/api/sessions/${sessionId}/messages`, { content }, signal);
    if (!res.body) return { kind: 'error', error: 'network' };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const data = buf
          .slice(0, end)
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        buf = buf.slice(end + 2);
        if (!data) continue;
        const ev = JSON.parse(data) as Record<string, unknown>;
        if (typeof ev.delta === 'string') on.delta(ev.delta);
        else if (typeof ev.user_message_id === 'number' && typeof ev.assistant_message_id === 'number')
          on.start({ user_message_id: ev.user_message_id, assistant_message_id: ev.assistant_message_id });
        else if (ev.done === true) return { kind: 'done' };
        else if (ev.error) return { kind: 'error', error: (ev.error as { kind: StreamErrorKind }).kind };
      }
    }
    return { kind: 'error', error: 'network' }; // closed without done/error
  } catch (err) {
    if (signal.aborted) return { kind: 'aborted' };
    if (err instanceof ApiError) throw err;
    return { kind: 'error', error: 'network' };
  }
}
