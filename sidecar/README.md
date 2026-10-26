# sidecar

Local ML for the app, on the RTX 2070 (Turing, sm_75). Today: Laya `multilingual` behind `laya-serve`.

- `pnpm sidecar:setup`: `uv sync`, `check_gpu.py` (must print capability `(7, 5)`), then a one-time download of
  `convaiinnovations/laya` `multilingual/` at the pinned revision into the Hugging Face cache (`~/.cache/huggingface`).
- `pnpm sidecar`: serves `POST /v1/systemone` on `127.0.0.1:8009`. It requires `Authorization: Bearer <laya key>`
  and runs with the HF offline flags. The key comes from `getSecret('laya')`; on first run a random one is stored
  in Windows Credential Manager.
- Bench: `pnpm --filter @agentic-os/server exec tsx ../scripts/decider-bench.ts` while the sidecar runs.

Notes:
- torch comes from the PyTorch `cu132` index: the newest Windows cp312 build that still ships sm_75 kernels.
  CUDA 13 already dropped everything below sm_75, so check `check_gpu.py` again on every torch or index bump.
- Weights stay fp32. On compute capability < 8, Laya autocasts to fp16 by itself; it never uses bf16 here.
- uv's cache is `sidecar/.uv-cache` (see `pyproject.toml`), because `%LOCALAPPDATA%\uv` is redirected to another
  volume on this machine and uv's renames fail there.
