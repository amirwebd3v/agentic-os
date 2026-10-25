---
id: W1-05
title: "LLM client, no-key mode, smoke test"
epic: AOS-W1
status: Backlog
points: 3
wave: 3
risk: Medium
depends_on:
  - "[[W1-02-database]]"
  - "[[W1-03-secrets]]"
skills:
  - typescript-pro
  - claude-api
started:
completed:
---

# W1-05 — LLM client (`llm.ts`), no-key mode, provider smoke test

**Points:** 3 · **Risk:** Medium (provider behaviour unverified) · **Depends on:** W1-02, W1-03 · **Skill/agent:** `typescript-pro`, `claude-api`
Overview: [plan-review.md §2b, §2c, §0c](../../plan-review.md) · Plan: [implementation-plan.md](../implementation-plan.md)

## Summary
One wrapper around `@anthropic-ai/sdk`. The `baseURL` comes from config and the key comes from the keychain. It supports streaming, structured output through `zodOutputFormat` + `messages.parse`, and prompt-cache markers, and it records every call in `llm_calls`. With no key, the app runs and reports `provider: "not_configured"`.

## Implementation steps
1. **`server/src/llm/client.ts`**
   - `getLlm()` returns `null` when the `anthropic` secret is missing. Otherwise it returns `new Anthropic({ apiKey, baseURL })`. The client is cached and rebuilt when the secret changes; `POST /api/provider/reload` triggers the rebuild.
   - `stream({ tier, system, messages, signal })` is an async iterator of text deltas plus final `usage`.
   - `structured<T>({ tier, system, input, schema: ZodType<T> })` returns `T`:
     ```ts
     const res = await client.messages.parse({
       model: cfg.llm.models[tier], max_tokens: 2048, system, messages: [{ role: 'user', content: input }],
       output_config: { format: zodOutputFormat(schema) },
     });
     return res.parsed_output;
     ```
   - `tier` is one of `fast | work | deep`, mapped to model IDs in config. Don't hardcode model IDs anywhere else.
2. **Prompt layout for caching:** `system` is an array of blocks ordered from stable to volatile: `CLAUDE.md` rules (`cache_control: { type: 'ephemeral' }`), then accepted persona (`cache_control`), then the per-request context. Turn content goes last.
3. **Ledger:** every call writes `llm_calls(pipeline, model, input_tokens, output_tokens, cache_read_tokens, latency_ms)`, including failed calls (with an error flag).
4. **Errors:** map SDK errors to `{ kind: 'auth' | 'rate_limit' | 'overloaded' | 'bad_request' | 'network' }`. Retry with backoff only on `rate_limit`, `overloaded`, and `network`, at most 3 times.
5. **`GET /api/provider`** returns `{ status: 'not_configured' | 'ok' | 'error', baseURL, models }`. The UI shows a "Connect provider" banner when the status isn't `ok`.
6. **`scripts/provider-smoke.ts`** (`pnpm smoke`) runs the 6 checks from plan §2b: plain, stream, tool round trip, cache hit on the 2nd call, batches endpoint, structured output + strict tool, and error mapping. It prints a ✅/❌/⏭ table and writes `data/provider-capabilities.json`, which feature flags such as `batch` and `cache` read. **With no key it skips everything with a clear message and exits 0.**

## Files
| File | Action |
|---|---|
| `server/src/llm/{client,errors,ledger}.ts` | Create |
| `server/src/http/routes/provider.ts` | Create |
| `scripts/provider-smoke.ts` | Create |
| `server/test/llm.test.ts` | Create |

## Tests — `server/test/llm.test.ts`
```ts
import { test, expect, vi } from 'vitest';
import { z } from 'zod';
vi.mock('../src/secrets', () => ({ getSecret: () => null }));
import { getLlm, providerStatus } from '../src/llm/client';
import { mapError } from '../src/llm/errors';

test('no key → not_configured, no throw', () => {
  expect(getLlm()).toBeNull();
  expect(providerStatus().status).toBe('not_configured');
});
test('error mapping', () => {
  expect(mapError({ status: 401 }).kind).toBe('auth');
  expect(mapError({ status: 429 }).kind).toBe('rate_limit');
  expect(mapError({ status: 529 }).kind).toBe('overloaded');
});
```

## Acceptance criteria
- [ ] Without a key: the server boots, `/api/provider` returns `not_configured`, and `pnpm smoke` exits 0 with skips.
- [ ] With a key (when you add it): `pnpm smoke` shows all 6 checks ✅ against `https://api.anthropic.com`.
- [ ] Changing `llm.baseURL` to a 9router URL needs no code change. Checks 1–3 are expected to pass, others may show ⏭/❌, and the results get recorded.
- [ ] Every call appears in `llm_calls`.
