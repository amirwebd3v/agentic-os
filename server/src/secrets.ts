import { Entry } from '@napi-rs/keyring';
import { readAppEnv } from './config.ts';

// Secrets come from the repo-root `.env` (gitignored) first, then Windows Credential Manager
// (service `agentic-os`). Never from argv, logs or committed files.
const SERVICE = 'agentic-os';

export const SECRET_NAMES = ['anthropic', 'laya', 'gmail_client_id', 'gmail_client_secret'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const ENV_KEYS: Record<SecretName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  laya: 'LAYA_API_KEY',
  gmail_client_id: 'GMAIL_CLIENT_ID',
  gmail_client_secret: 'GMAIL_CLIENT_SECRET',
};

export const isSecretName = (name: string): name is SecretName => (SECRET_NAMES as readonly string[]).includes(name);

/** Where a secret currently comes from, or null when it is unset. Never throws. */
export function secretSource(name: SecretName): '.env' | 'Credential Manager' | null {
  try {
    if (readAppEnv()[ENV_KEYS[name]]) return '.env';
    return new Entry(SERVICE, name).getPassword() ? 'Credential Manager' : null;
  } catch {
    return null;
  }
}

/** Returns null when the secret is missing or unreadable; never throws. */
export function getSecret(name: SecretName): string | null {
  try {
    return readAppEnv()[ENV_KEYS[name]] || new Entry(SERVICE, name).getPassword() || null;
  } catch {
    return null;
  }
}

export function setSecret(name: SecretName, value: string): void {
  if (!value) throw new Error(`Refusing to store an empty ${name} secret`);
  new Entry(SERVICE, name).setPassword(value);
}
