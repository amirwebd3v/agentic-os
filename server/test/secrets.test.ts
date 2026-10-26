import { test, expect, vi } from 'vitest';

const keyring = vi.hoisted(() => ({ store: new Map<string, string>(), fail: false }));
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    constructor(
      private service: string,
      private account: string,
    ) {}
    getPassword() {
      if (keyring.fail) throw new Error('backend failure');
      return keyring.store.get(`${this.service}/${this.account}`) ?? null;
    }
    setPassword(v: string) {
      keyring.store.set(`${this.service}/${this.account}`, v);
    }
  },
}));

import { getSecret, isSecretName, setSecret } from '../src/secrets.ts';

test('missing secret is null, set secret round-trips under service agentic-os', () => {
  expect(getSecret('anthropic')).toBeNull();
  setSecret('anthropic', 'x');
  expect(getSecret('anthropic')).toBe('x');
  expect(keyring.store.get('agentic-os/anthropic')).toBe('x');
});

test('getSecret never throws, even if the store fails', () => {
  keyring.fail = true;
  expect(getSecret('anthropic')).toBeNull();
  keyring.fail = false;
});

test('empty values are refused, unknown names are rejected', () => {
  expect(() => setSecret('laya', '')).toThrow();
  expect(isSecretName('laya')).toBe(true);
  expect(isSecretName('github')).toBe(false);
});
