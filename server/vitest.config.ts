import { defineConfig } from 'vitest/config';

// Tests never read the real repo-root .env (it holds the live key); tests opt in with a temp file.
export default defineConfig({ test: { env: { AOS_ENV_FILE: '' } } });
