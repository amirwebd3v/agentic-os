import { test, expect, vi } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    constructor(
      private service: string,
      private account: string,
    ) {}
    private get key() {
      return `${this.service}/${this.account}`;
    }
    getPassword() {
      if (this.account === 'laya' && store.has('broken')) throw new Error('backend failure');
      return store.get(this.key) ?? null;
    }
    setPassword(v: string) {
      store.set(this.key, v);
    }
  },
}));

import { getSecret, isSecretName, setSecret } from '../src/secrets.ts';

test('missing secret is null, set secret round-trips under service agentic-os', () => {
  expect(getSecret('anthropic')).toBeNull();
  setSecret('anthropic', 'x');
  expect(getSecret('anthropic')).toBe('x');
  expect(store.get('agentic-os/anthropic')).toBe('x');
});

test('getSecret never throws, even if the store fails', () => {
  store.set('broken', '1');
  expect(getSecret('laya')).toBeNull();
  store.delete('broken');
});

test('empty values are refused, unknown names are rejected', () => {
  expect(() => setSecret('laya', '')).toThrow();
  expect(isSecretName('laya')).toBe(true);
  expect(isSecretName('github')).toBe(false);
});
