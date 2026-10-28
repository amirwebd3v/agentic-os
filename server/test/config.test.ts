import { describe, test, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseConfig, readAppEnv, repoRoot } from '../src/config.ts';

const dirs = { vaultDir: resolve('/AgenticOS/vault'), dataDir: resolve('/AgenticOS/data') };

describe('config', () => {
  test('fills defaults', () => {
    const c = parseConfig(dirs);
    expect(c.server.port).toBe(3000);
    expect(c.decider.escalateBelow).toBe(0.6);
    expect(c.llm.models.work).toBe('claude-sonnet-5-5');
  });

  test('rejects OneDrive paths', () => {
    expect(() => parseConfig({ ...dirs, vaultDir: resolve('/Users/x/OneDrive/vault') })).toThrow(/OneDrive/);
  });

  test('rejects data dirs inside the code repo', () => {
    expect(() => parseConfig({ ...dirs, dataDir: resolve(repoRoot, 'data') })).toThrow(/outside the code repo/);
  });

  test('rejects relative paths', () => {
    expect(() => parseConfig({ ...dirs, dataDir: './data' })).toThrow(/absolute/);
  });

  test('a child dir whose name starts with .. is still inside the repo', () => {
    expect(() => parseConfig({ ...dirs, dataDir: resolve(repoRoot, '..data') })).toThrow(/outside the code repo/);
  });

  test('.env overrides llm settings and strips a trailing /v1', () => {
    const c = parseConfig(dirs, repoRoot, {
      ANTHROPIC_BASE_URL: 'http://localhost:20128/v1/',
      ANTHROPIC_MODEL: 'cc/claude-sonnet-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'ignored-when-ANTHROPIC_MODEL-set',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'cc/claude-opus-4-8',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'cc/claude-haiku-4-5-20251001',
    });
    expect(c.llm.baseURL).toBe('http://localhost:20128');
    expect(c.llm.models).toEqual({ fast: 'cc/claude-haiku-4-5-20251001', work: 'cc/claude-sonnet-5', deep: 'cc/claude-opus-4-8' });
  });

  test('readAppEnv reads only the file, never the inherited process env', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'aos-env-')), '.env');
    writeFileSync(file, 'ANTHROPIC_MODEL=from-file\n');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'); // what Claude Code exports
    const env = readAppEnv(file);
    vi.unstubAllEnvs();
    expect(env.ANTHROPIC_MODEL).toBe('from-file');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(readAppEnv(join(tmpdir(), 'missing-aos.env'))).toEqual({});
    expect(readAppEnv('')).toEqual({});
  });

  test('example config stays valid', () => {
    const example = JSON.parse(readFileSync(resolve(repoRoot, 'agentic-os.example.json'), 'utf8'));
    // The example's Windows drive paths aren't absolute on POSIX.
    expect(() => parseConfig(process.platform === 'win32' ? example : { ...example, ...dirs })).not.toThrow();
  });
});
