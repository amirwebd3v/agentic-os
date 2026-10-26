# Chat API contract (W1-06 ⇄ W1-07)

These are the shapes both Wave 4 tickets build against. W1-06 implements them, and W1-07 consumes them (mocking them until W1-06 merges). If you change a shape, edit this file in the same PR and tell the sibling session.

## Rules (from W1-04, already on `main`)
- **Mount point:** everything is under `/api`, behind the session cookie `aos_session`. Without the cookie you get 401.
- **State-changing requests** (POST/PATCH/DELETE) need `Origin` = the app origin **and** the header `X-AOS: 1`. Otherwise you get 403.
- **Browser requests:** the web client always sends `credentials: 'same-origin'` and `X-AOS: 1`.
- **Login:** the server prints `/login?t=<token>` at boot. Run `pnpm login-url` to get a new one.

## Endpoints
| Method & path | Body | Response |
|---|---|---|
| `GET /api/provider` *(exists)* | — | `{ status: 'ok' \| 'not_configured' \| 'error', baseURL, models: { fast, work, deep } }` |
| `POST /api/provider/reload` *(exists)* | — | `{ status, … }` |
| `GET /api/areas` | — | `Area[]`, active and proposed only |
| `GET /api/sessions?area=<slug>&q=<text>` | — | `SessionSummary[]`, newest activity first |
| `POST /api/sessions` | `{ mode: 'chat' \| 'persona' }` | `201 SessionSummary` |
| `GET /api/sessions/:id` | — | `{ session: SessionSummary, messages: Message[] }` (404 if unknown) |
| `PATCH /api/sessions/:id` | `{ title?: string, area_id?: number }` | `SessionSummary`. Setting `area_id` makes `filing_status: 'user'`. |
| `POST /api/sessions/:id/end` | — | `202 { queued: boolean }` |
| `POST /api/sessions/:id/messages` | `{ content: string }` (1–20 000 chars) | `text/event-stream`, see below. `409 { error: 'provider_not_configured' }` when there's no key. |

## Types
```ts
type Area = { id: number; slug: string; name: string; parent_id: number | null; status: 'active' | 'proposed'; mode: 'do' | 'explain' | 'tutor' };
type SessionSummary = {
  id: number; title: string | null; mode: 'chat' | 'persona';
  area_id: number | null; area_slug: string | null;
  filing_status: 'auto' | 'flagged' | 'inbox' | 'user' | null; area_confidence: number | null;
  started_at: string; last_message_at: string | null; // ISO-8601 UTC
};
type Message = { id: number; role: 'user' | 'assistant'; content: string; status: 'streaming' | 'done' | 'aborted' | 'error'; created_at: string };
```

## Streaming (SSE over a POST response; the client reads it with `fetch` + `ReadableStream`, not `EventSource`)
Each event is one `data: <json>\n\n` line. In order:
1. `{ "user_message_id": n, "assistant_message_id": m }`, sent once, first.
2. `{ "delta": "text" }`, repeated.
3. It ends with exactly one of:
   - `{ "done": true, "usage": { "input_tokens", "output_tokens", "cache_read_tokens" } }`
   - `{ "error": { "kind": "auth" | "rate_limit" | "overloaded" | "bad_request" | "network" } }`

**Aborting:** if the client aborts the fetch, the server stops the model call and stores the partial reply as `status: 'aborted'`. Messages still `streaming` at boot become `aborted`.
