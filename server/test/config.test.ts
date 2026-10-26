import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseConfig, repoRoot } from '../src/config.ts';

const dirs = { vaultDir: 'E:/AgenticOS/vault', dataDir: 'E:/AgenticOS/data' };

describe('config', () => {
  test('fills defaults', () => {
    const c = parseConfig(dirs);
    expect(c.server.port).toBe(3000);
    expect(c.decider.escalateBelow).toBe(0.6);
    expect(c.llm.models.work).toBe('claude-sonnet-5-5');
  });

  test('rejects OneDrive paths', () => {
    expect(() => parseConfig({ ...dirs, vaultDir: 'C:/Users/x/OneDrive/vault' })).toThrow(/OneDrive/);
  });

  test('rejects data dirs inside the code repo', () => {
    expect(() => parseConfig({ ...dirs, dataDir: resolve(repoRoot, 'data') })).toThrow(/outside the code repo/);
  });

  test('rejects relative paths', () => {
    expect(() => parseConfig({ ...dirs, dataDir: './data' })).toThrow(/absolute/);
  });

  test('allows a sibling dir whose name starts with ..', () => {
    expect(() => parseConfig({ ...dirs, dataDir: resolve(repoRoot, '..data') })).not.toThrow();
  });

  test('example config stays valid', () => {
    const example = JSON.parse(readFileSync(resolve(repoRoot, 'agentic-os.example.json'), 'utf8'));
    expect(() => parseConfig(example)).not.toThrow();
  });
});
