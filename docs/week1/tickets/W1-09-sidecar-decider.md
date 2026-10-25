---
id: W1-09
title: "Python sidecar (Laya CUDA) + decider client"
epic: AOS-W1
status: Backlog
points: 3
wave: 3
risk: Medium
depends_on:
  - "[[W1-01-scaffold]]"
  - "[[W1-03-secrets]]"
skills:
  - python-pro
  - typescript-pro
started:
completed:
---

# W1-09 — Python sidecar (Laya on CUDA) + `decider.ts` client

**Points:** 3 · **Risk:** Medium (new library, GPU setup on Windows) · **Depends on:** W1-01, W1-03 · **Skill/agent:** `python-pro`, `typescript-pro`
Overview: [plan-review.md §0a](../../plan-review.md) · Plan: [implementation-plan.md](../implementation-plan.md)

## Summary
A `sidecar/` Python project managed by `uv`, running `laya-serve` with the **multilingual** checkpoint on the RTX 2070. It binds to localhost and requires a bearer key. On the TypeScript side, `decider.ts` speaks `/v1/systemone`, so Kev or Jev can be swapped in later through config. Docling and bge-m3 join this sidecar in Month 1.

## Implementation steps
1. **Install `uv`:** `winget install --id=astral-sh.uv -e`. It's missing on this machine, as checked on 2026-10-26.
2. **`sidecar/pyproject.toml`:** Python 3.12, `laya[serve]==<pin>`, and `torch` from the PyTorch CUDA index:
   ```toml
   [project]
   name = "aos-sidecar"
   requires-python = ">=3.12,<3.13"
   dependencies = ["laya[serve]==<pin exact version>", "torch"]
   [[tool.uv.index]]
   name = "pytorch-cuda"
   url = "https://download.pytorch.org/whl/cu126"   # ⚠️ pick the newest CUDA wheel that still lists sm_75 (Turing)
   explicit = true
   [tool.uv.sources]
   torch = { index = "pytorch-cuda" }
   ```
3. **`sidecar/check_gpu.py`:** prints `torch.cuda.is_available()`, the device name and `get_device_capability()`, which must be `(7, 5)`. Run fp32, since Turing has no bf16. **`pnpm sidecar:setup`** = `uv sync` + `check_gpu.py` + a one-time model download with a **pinned HF revision**:
   `huggingface-cli download convaiinnovations/laya-multilingual --revision <commit-sha>`.
4. **`scripts/sidecar.ts`** (`pnpm sidecar`, also started by `pnpm dev` via `concurrently`): reads or creates the `laya` secret, then spawns `uv run laya-serve` with this environment:
   ```
   LAYA_HOST=127.0.0.1  LAYA_PORT=8009  LAYA_DEVICE=cuda  LAYA_MODELS=multilingual
   LAYA_PRELOAD=1  LAYA_MAX_LOADED=1  LAYA_DEFAULT_MODEL=multilingual  LAYA_API_KEY=<from keychain>
   HF_HUB_OFFLINE=1  TRANSFORMERS_OFFLINE=1
   ```
   **Don't rely on laya-serve's defaults:** it binds `0.0.0.0` and preloads all 3 checkpoints by default.
5. **Capture the wire format first:** run one real request and save the response to `server/test/fixtures/systemone-response.json`. The README doesn't fully document the HTTP response shape, so write the Zod schema from this fixture.
6. **`server/src/decider/client.ts`:**
   - `decide(state, questions, { model, maxLen })` returns `{ answers: Record<string, { choice?, score?, noul?, confidence, probabilities? }>, latencyMs }`.
   - Timeout 5 s. Send the bearer header. Validate with the Zod schema from step 5.
   - Insert a `decisions` row for every question, with `backend='laya'` and `model`.
   - `deciderStatus()` is used by `/api/provider` → `{ decider: 'ok' | 'down' }`. **If the decider is down, callers fall back to Claude.**
7. **`scripts/decider-bench.ts`:** runs 50 calls and reports p50/p95 latency, then reads `nvidia-smi --query-gpu=memory.used --format=csv`.

## Files
| File | Action |
|---|---|
| `sidecar/{pyproject.toml,check_gpu.py,README.md}`, `scripts/{sidecar,decider-bench}.ts` | Create |
| `server/src/decider/client.ts`, `server/test/fixtures/systemone-response.json` | Create |
| `server/test/decider.test.ts` | Create |

## Tests — `server/test/decider.test.ts`
```ts
import { test, expect } from 'vitest';
import { createServer } from 'node:http';
import fixture from './fixtures/systemone-response.json';
import { createDecider } from '../src/decider/client';
import { makeTestDb } from './helpers';

test('sends bearer key, parses fixture, logs decisions', async () => {
  let auth = '';
  const srv = createServer((req, res) => { auth = req.headers.authorization ?? ''; res.setHeader('content-type','application/json'); res.end(JSON.stringify(fixture)); });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const db = makeTestDb();
  const d = createDecider({ db, baseURL: `http://127.0.0.1:${(srv.address() as any).port}`, apiKey: 'k', model: 'multilingual' });
  const out = await d.decide({ body: 'x' }, { area: { type: 'choice', instructions: 'which area?', criteria: { a: 'A', b: 'B' } } });
  expect(auth).toBe('Bearer k');
  expect(out.answers.area.confidence).toBeGreaterThanOrEqual(0);
  expect(db.prepare('SELECT count(*) n FROM decisions').get().n).toBe(1);
  srv.close();
});
test('down decider → typed error, not a hang', async () => {
  const d = createDecider({ db: makeTestDb(), baseURL: 'http://127.0.0.1:1', apiKey: 'k', model: 'multilingual' });
  await expect(d.decide({}, {})).rejects.toMatchObject({ kind: 'decider_down' });
});
```

## Acceptance criteria
- [ ] `check_gpu.py` reports CUDA available on the RTX 2070, capability (7, 5).
- [ ] `netstat` shows the sidecar only on `127.0.0.1:8009`. A request without the bearer key gets 401.
- [ ] `decider-bench`: p50 under 200 ms, `nvidia-smi` under 7 GB used.
- [ ] Classification works with the network disconnected.
