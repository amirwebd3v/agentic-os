import { defineConfig } from 'vitest/config';

// Tests never read the real repo-root .env (it holds the live key); tests opt in with a temp file.
// Tests that spawn real git (vault) take ~5 s on Windows under load; 5 s default made them flaky.
export default defineConfig({ test: { env: { AOS_ENV_FILE: '' }, testTimeout: 30_000 } });
