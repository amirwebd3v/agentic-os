import { Entry } from '@napi-rs/keyring';

// Secrets live only in Windows Credential Manager (service `agentic-os`), never in files, logs or argv.
const SERVICE = 'agentic-os';

export const SECRET_NAMES = ['anthropic', 'laya'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export const isSecretName = (name: string): name is SecretName => (SECRET_NAMES as readonly string[]).includes(name);

/** Returns null when the secret is missing or the store is unreadable; never throws. */
export function getSecret(name: SecretName): string | null {
  try {
    return new Entry(SERVICE, name).getPassword() ?? null;
  } catch {
    return null;
  }
}

export function setSecret(name: SecretName, value: string): void {
  if (!value) throw new Error(`Refusing to store an empty ${name} secret`);
  new Entry(SERVICE, name).setPassword(value);
}
