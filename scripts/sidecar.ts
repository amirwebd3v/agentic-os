// `pnpm sidecar:setup` installs the Python env, checks the GPU and downloads the pinned checkpoint.
// `pnpm sidecar` serves Laya on 127.0.0.1:8009 behind the `laya` bearer key.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { repoRoot } from '../server/src/config.ts';
import { getSecret, setSecret } from '../server/src/secrets.ts';

// laya-serve loads `multilingual` from this bundle repo's `multilingual/` subfolder (laya/router.py
// DEFAULT_MODELS), not from the standalone convaiinnovations/laya-multilingual repo.
const REPO = 'convaiinnovations/laya';
// laya 0.4.15's reviewed SHA for REPO (laya/revisions.py PINNED_REVISIONS). Bump together with laya.
const REVISION = '55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851';
const cwd = resolve(repoRoot, 'sidecar');

function uv(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const r = spawnSync('uv', args, { cwd, env, stdio: 'inherit' });
  if (r.error) throw new Error(`uv failed to start (${r.error.message}). Install it: winget install --id=astral-sh.uv -e`);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (process.argv[2] === 'setup') {
  uv(['sync']);
  uv(['run', 'python', 'check_gpu.py']);
  uv(['run', 'hf', 'download', REPO, '--revision', REVISION, '--include', 'multilingual/*']);
} else {
  let apiKey = getSecret('laya');
  if (!apiKey) {
    apiKey = randomBytes(32).toString('base64url');
    setSecret('laya', apiKey);
    console.log('Generated a new laya key in Windows Credential Manager.');
  }
  // laya-serve's own defaults bind 0.0.0.0 and preload every checkpoint, so every knob is explicit.
  uv(['run', '--no-sync', 'laya-serve'], {
    ...process.env,
    LAYA_HOST: '127.0.0.1',
    LAYA_PORT: '8009',
    LAYA_DEVICE: 'cuda',
    LAYA_MODELS: 'multilingual',
    LAYA_DEFAULT_MODEL: 'multilingual',
    LAYA_PRELOAD: '1',
    LAYA_MAX_LOADED: '1',
    LAYA_REVISION: REVISION,
    LAYA_API_KEY: apiKey,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
  });
}
