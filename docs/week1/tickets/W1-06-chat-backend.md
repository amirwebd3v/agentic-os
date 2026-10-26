---
id: W1-06
title: "Chat backend, SSE, crash-safe persistence"
epic: AOS-W1
issue: https://github.com/amirwebd3v/agentic-os/issues/6
points: 3
wave: 4
risk: Medium
depends_on:
  - "[[W1-04-server-security]]"
  - "[[W1-05-llm-client]]"
skills:
  - typescript-pro
  - websocket-engineer
---

# W1-06 — Chat backend: sessions, streaming, crash-safe persistence

**Points:** 3 · **Risk:** Medium · **Depends on:** W1-04, W1-05 · **Skill/agent:** `typescript-pro`, `websocket-engineer` (SSE)
Overview: [plan-review.md §6 Week 1](../../plan-review.md) · Plan: [implementation-plan.md](../implementation-plan.md)

## Summary
A REST API for sessions, plus a streaming endpoint for the assistant's replies. Partial replies are flushed to the DB so a crash or a kill keeps them. **Week 1 chat has no tools.** Brain tools (`search`, `get_item`, …) arrive with the index in Month 1.

## Implementation steps
1. **Routes** (`server/src/http/routes/sessions.ts`):
   - `GET /api/sessions?area=&q=`: list, newest first, with area, `filing_status` and confidence.
   - `POST /api/sessions { mode: 'chat'|'persona' }`: create.
   - `GET /api/sessions/:id`: session + messages.
   - `PATCH /api/sessions/:id { title?, area_id? }`: a manual area change sets `filing_status='user'` and records a `decisions` correction (training data).
   - `POST /api/sessions/:id/end`: enqueue categorization (W1-10).
   - `POST /api/sessions/:id/messages { content }`: the response is `text/event-stream`.
2. **Streaming handler:**
   1. Insert the user message.
   2. Insert an assistant message with `status='streaming'`.
   3. Iterate `llm.stream(...)`, writing `data: {"delta": "..."}` events.
   4. **Flush accumulated content to the DB every 1 s.**
   5. On finish, set `status='done'` and write `data: {"done": true, "usage": ...}`.
   6. On client abort (`request.raw.on('close')`), abort the SDK call and set `status='aborted'`.
   7. On error, set `status='error'` and send `data: {"error": {kind}}`.
3. **Boot recovery:** any message still `streaming` at startup becomes `aborted`, so the content is kept.
4. **Prompt assembly** (`server/src/chat/prompt.ts`): system = rules from `vault/CLAUDE.md` + accepted persona files + mode instructions (persona mode → W1-12). History is the last N messages, kept within a token budget (start with 40 messages).
5. **Provider missing:** the POST returns 409 `{ error: 'provider_not_configured' }`, and the UI shows the banner.
6. **Idle categorization trigger:** an `setInterval` every 60 s enqueues `categorize_session` for sessions idle at least `session.idleMinutes` whose `last_categorized_message_id` is behind. The idempotency key is `categorize:<sid>:<lastMsgId>`.

## Files
| File | Action |
|---|---|
| `server/src/http/routes/sessions.ts`, `server/src/chat/{stream,prompt,idle}.ts` | Create |
| `server/test/chat.test.ts` | Create |

## Tests — `server/test/chat.test.ts`
```ts
import { test, expect } from 'vitest';
import { buildTestApp, fakeLlm } from './helpers';

test('streams and persists; aborted stream keeps partial content', async () => {
  const llm = fakeLlm(['Hel', 'lo ', 'wor', 'ld'], { delayMs: 600, failAfter: 2 }); // throws after 2 chunks
  const { app, db, authed } = await buildTestApp({ loggedIn: true, llm });
  const s = (await app.inject(authed({ method: 'POST', url: '/api/sessions', payload: { mode: 'chat' } }))).json();
  await app.inject(authed({ method: 'POST', url: `/api/sessions/${s.id}/messages`, payload: { content: 'hi' } }));
  const msg = db.prepare("SELECT content, status FROM messages WHERE role='assistant'").get() as any;
  expect(msg.status).toBe('error');
  expect(msg.content).toBe('Hello ');
});

test('manual area change records a correction', async () => {
  const { app, db, authed, areaId } = await buildTestApp({ loggedIn: true });
  const s = (await app.inject(authed({ method: 'POST', url: '/api/sessions', payload: { mode: 'chat' } }))).json();
  await app.inject(authed({ method: 'PATCH', url: `/api/sessions/${s.id}`, payload: { area_id: areaId('software-development') } }));
  expect((db.prepare('SELECT corrected_by_user c FROM decisions').get() as any)?.c).toBe(1);
});
```

## Acceptance criteria
- [x] Killing the server process mid-stream, then restarting, shows the partial reply marked "interrupted".
- [x] Listing 100 sessions takes under 100 ms (seed script + timing log).
- [x] With no key configured, chat returns a clear "connect provider" error and nothing crashes.
