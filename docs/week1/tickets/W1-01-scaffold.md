---
id: W1-01
title: "Monorepo scaffold, config, tooling"
epic: AOS-W1
issue: https://github.com/amirwebd3v/agentic-os/issues/1
points: 2
wave: 1
risk: Low
depends_on: []
skills:
  - typescript-pro
---

# W1-01 — Monorepo scaffold, config, tooling

**Points:** 2 · **Risk:** Low · **Depends on:** — · **Skill/agent:** `typescript-pro`
Overview: [plan-review.md](../../plan-review.md) · Plan: [implementation-plan.md](../implementation-plan.md)

## Summary
Create the code repo skeleton (pnpm workspaces: `server`, `web`), TypeScript strict, Vitest, ESLint, a Zod-validated config file, and the data/vault directory conventions. The code repo must never contain personal data.

## Implementation steps
1. **Init the code repo** at `E:\Projects\Agentic OS` (`git init -b main`).
2. **Workspaces:** `pnpm-workspace.yaml` → `packages: [server, web]`. In the root `package.json`, add scripts:
   `dev`, `build`, `test`, `lint`, `typecheck`, `verify` (= typecheck + lint + test), `sidecar:setup`, `sidecar`, `smoke`, `eval:categorize`.
3. **TypeScript:** `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, ES2023, module NodeNext). `server/tsconfig.json` and `web/tsconfig.json` extend it.
4. **Server package:** `server/package.json` (type module), `tsx` for dev, `vitest`.
5. **Lint:** `eslint.config.js` (flat config, `typescript-eslint` recommended + `eslint-plugin-vue` for web).
6. **Config:** `server/src/config.ts` loads `agentic-os.json` from the repo root (gitignored), validates it with Zod, and fills defaults. Commit `agentic-os.example.json`:
   ```json
   {
     "vaultDir": "E:/AgenticOS/vault",
     "dataDir":  "E:/AgenticOS/data",
     "server":   { "port": 3000 },
     "llm":      { "baseURL": "https://api.anthropic.com",
                   "models": { "fast": "claude-haiku-5-5", "work": "claude-sonnet-5-5", "deep": "claude-opus-5-5" } },
     "decider":  { "baseURL": "http://127.0.0.1:8009", "model": "multilingual", "escalateBelow": 0.6 },
     "session":  { "idleMinutes": 15 }
   }
   ```
   `vaultDir` and `dataDir` sit **outside** the code repo and outside OneDrive. The loader refuses paths that contain `OneDrive`.
7. **`.gitignore`:** `node_modules`, `dist`, `agentic-os.json`, `*.db*`, `.env*`, `sidecar/.venv`.

## Files
| File | Action |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.gitignore`, `agentic-os.example.json` | Create |
| `server/package.json`, `server/tsconfig.json`, `server/src/config.ts` | Create |
| `server/test/config.test.ts` | Create |

## Tests — `server/test/config.test.ts`
```ts
import { describe, test, expect } from 'vitest';
import { parseConfig } from '../src/config';

describe('config', () => {
  test('fills defaults', () => {
    const c = parseConfig({ vaultDir: 'E:/AgenticOS/vault', dataDir: 'E:/AgenticOS/data' });
    expect(c.server.port).toBe(3000);
    expect(c.decider.escalateBelow).toBe(0.6);
  });
  test('rejects OneDrive paths', () => {
    expect(() => parseConfig({ vaultDir: 'C:/Users/x/OneDrive/vault', dataDir: 'E:/d' })).toThrow(/OneDrive/);
  });
});
```

## Acceptance criteria
- [x] `pnpm i && pnpm verify` passes on a clean clone.
- [x] `git status` shows no `agentic-os.json` and no data files.
- [x] The config tests pass.
