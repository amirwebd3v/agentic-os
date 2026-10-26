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

const PORT = 8009;

/**
 * Windows doesn't kill grandchildren: a hard-killed `pnpm sidecar` leaves uv → python holding the port and ~1.6 GB
 * VRAM. So before starting, reap a stale laya-serve on our port; refuse to touch anything else listening there.
 */
function reapStaleSidecar(): void {
  const ps = `$c = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
  if ($p.CommandLine -match 'laya') { taskkill /PID $p.ProcessId /T /F | Out-Null; "reaped $($p.ProcessId)" } else { "busy $($p.Name)" } }`;
  const out = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).stdout.trim();
  if (out.startsWith('reaped')) console.log(`Stopped a stale sidecar from an earlier run (pid ${out.split(' ')[1]}).`);
  if (out.startsWith('busy')) throw new Error(`Port ${PORT} is in use by ${out.slice(5)}, not a sidecar. Free it first.`);
}

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
  // Drop inherited LAYA_* (e.g. LAYA_JEV_STRICT would change the wire format the client parses).
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LAYA_')));
  reapStaleSidecar();
  uv(['run', '--no-sync', 'laya-serve'], {
    ...inherited,
    LAYA_HOST: '127.0.0.1',
    LAYA_PORT: String(PORT),
    LAYA_DEVICE: 'cuda',
    LAYA_MODELS: 'multilingual',
    LAYA_DEFAULT_MODEL: 'multilingual',
    LAYA_PRELOAD: '1',
    LAYA_MAX_LOADED: '1',
    LAYA_REVISION: REVISION,
    LAYA_API_KEY: apiKey,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
  });
}
