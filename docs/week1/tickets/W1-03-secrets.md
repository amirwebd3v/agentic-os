---
id: W1-03
title: "Secrets in Windows Credential Manager"
epic: AOS-W1
status: Backlog
points: 1
wave: 2
risk: Low
depends_on:
  - "[[W1-01-scaffold]]"
skills:
  - secure-code-guardian
started:
completed:
---

# W1-03 — Secrets in Windows Credential Manager

**Points:** 1 · **Risk:** Low · **Depends on:** W1-01 · **Skill/agent:** `secure-code-guardian`
Overview: [plan-review.md](../../plan-review.md) · Plan: [implementation-plan.md](../implementation-plan.md)

## Summary
A wrapper over `@napi-rs/keyring` (service `agentic-os`) plus a tiny CLI so you can add your API key later without it ever touching a file.

⚠️ First step: confirm that `@napi-rs/keyring` is current and maintained on npm and that it works on Windows 11 (`keytar` is archived). If it fails, fall back to `cmdkey`/PowerShell `CredentialManager`. Don't fall back to a plaintext file.

## Implementation steps
1. **`server/src/secrets.ts`:** `getSecret(name)` and `setSecret(name, value)` for the names `anthropic`, `laya`. `getSecret` returns `null` when a secret is missing and never throws.
2. **`server/src/cli/secrets.ts`:** `pnpm secrets set anthropic` reads the value from a **hidden prompt**. It's never accepted as a command-line argument, so it can't end up in shell history. `pnpm secrets status` prints which secrets are set, never their values.
3. **`laya` key:** if missing, generate one with `crypto.randomBytes(32).toString('base64url')` on first `pnpm sidecar`.
4. **Logger redaction:** the Fastify/pino config redacts `authorization`, `x-api-key`, `*.apiKey`, and `*.token`.

## Files
| File | Action |
|---|---|
| `server/src/secrets.ts`, `server/src/cli/secrets.ts` | Create |
| `server/test/secrets.test.ts` | Create (mocks the keyring module) |

## Tests
```ts
import { test, expect, vi } from 'vitest';
vi.mock('@napi-rs/keyring', () => {
  const store = new Map<string, string>();
  return { Entry: class { constructor(private s: string, private a: string) {}
    getPassword() { return store.get(this.a) ?? null; } setPassword(v: string) { store.set(this.a, v); } } };
});
import { getSecret, setSecret } from '../src/secrets';
test('missing secret is null, set secret round-trips', () => {
  expect(getSecret('anthropic')).toBeNull();
  setSecret('anthropic', 'x');
  expect(getSecret('anthropic')).toBe('x');
});
```

## Acceptance criteria
- [ ] `pnpm secrets set anthropic` stores the key, and it appears in Windows Credential Manager under `agentic-os`.
- [ ] `git grep -i "sk-ant"` finds nothing. Logs never show a key.
