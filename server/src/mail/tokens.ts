import { Entry } from '@napi-rs/keyring';

// One refresh token per Gmail account, in Windows Credential Manager only: never `.env`, the database or a log.
// `SECRET_NAMES` is a fixed list, and accounts come and go, so they get this accessor instead.
const entry = (accountId: number) => new Entry('agentic-os', `gmail:${accountId}`);

export interface TokenStore {
  get(accountId: number): string | null;
  set(accountId: number, token: string): void;
  delete(accountId: number): void;
}

export const credentialManagerTokens: TokenStore = {
  get(accountId) {
    try {
      return entry(accountId).getPassword();
    } catch {
      return null;
    }
  },
  set(accountId, token) {
    entry(accountId).setPassword(token);
  },
  delete(accountId) {
    entry(accountId).deletePassword();
  },
};
