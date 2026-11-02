// Words shared by the Email page's parts. Every value here is the app's own text; mail text never passes through.
import type { ConnectFlow, MailAccount, MailParagraph } from './api';

export function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return minutes < 2880 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
}

/** "2 Nov", in the reader's locale; the year only when it isn't this one. */
export function mailDay(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function paragraphMeta(p: MailParagraph): string {
  const parts = [`written ${ago(p.created_at)}`, `from ${plural(p.cites.length, 'mail')}`];
  parts.push(p.cost_usd === null ? 'cost not priced' : `$${p.cost_usd.toFixed(3)}`);
  return parts.join(' · ');
}

export const FLOW_TEXT: Partial<Record<ConnectFlow, string>> = {
  connected: 'Connected. The first sync starts now.',
  cancelled: 'Nothing was connected.',
  timed_out: 'The wait for Google ran out. Nothing was connected.',
  wrong_scope: 'Google gave wider access than read-only, so the app refused and revoked it. Nothing was connected.',
};

/** What to do about a failed connect, from the server's fixed reason code. */
export function failureText(reason: string | null): string {
  const tail = ` Nothing was stored.${reason ? ` (Code: ${reason})` : ''}`;
  if (reason?.startsWith('profile:') && /accessNotConfigured|SERVICE_DISABLED/.test(reason)) return `Google signed you in, but the Gmail API isn't enabled in your Google Cloud project. Enable it under APIs & Services, wait a minute, then connect again.${tail}`;
  if (reason?.startsWith('profile:auth') || reason?.startsWith('profile:bad_request')) return `Google signed you in, but refused to let the app read your Gmail profile. Check that the Gmail API is enabled and your account is allowed to use the app (a test user, if the app is still in Testing).${tail}`;
  if (reason === 'exchange:redirect_uri_mismatch' || reason === 'exchange:invalid_client' || reason === 'exchange:unauthorized_client') return `Google refused the app's OAuth client. It must be a Desktop app client, saved with pnpm secrets set gmail_client_id and gmail_client_secret.${tail}`;
  if (reason === 'exchange:invalid_grant') return `Google refused the sign-in code. It can expire within a minute; connect again and finish without waiting.${tail}`;
  if (reason === 'no_refresh_token') return `Google didn't give the app lasting access. Remove the app under Security in your Google Account, then connect again.${tail}`;
  if (reason === 'store') return `Signed in, but the token couldn't be saved in Windows Credential Manager.${tail}`;
  return `Connecting failed.${tail} Try again.`;
}

/** One status word per account, and the class of its dot. Problems first: they are what the owner must act on. */
export function accountState(a: MailAccount): { word: string; tone: '' | 'ready' | 'attention' | 'danger' | 'working'; detail: string } {
  if (a.status === 'disconnected') return { word: 'Disconnected', tone: '', detail: 'Its mail stays here; nothing new is read.' };
  if (a.status === 'reconnect') {
    if (a.last_error === 'deleted_client') return { word: 'Needs reconnecting', tone: 'danger', detail: 'The Google client was deleted. Restore it in the Google Cloud console within 30 days, then reconnect.' };
    if (a.last_error === 'invalid_client') return { word: 'Needs reconnecting', tone: 'danger', detail: 'Google refused the saved client. Save it again with pnpm secrets, then reconnect.' };
    return { word: 'Needs reconnecting', tone: 'danger', detail: 'Google ended this access. Reconnect to keep reading new mail.' };
  }
  if (a.triage_error === 'classifier_down') return { word: 'Sorting paused', tone: 'attention', detail: 'The classifier (Laya) is down. Start the app with pnpm dev; nothing goes to Claude instead.' };
  if (a.triage_error === 'contact_unreadable') return { word: 'Sorting paused', tone: 'attention', detail: 'career/contact.md could not be read. Fix it, and sorting starts again.' };
  const synced = a.last_synced_at ? `Synced ${ago(a.last_synced_at)}` : 'First sync running';
  const pending = a.pending ? ` · ${plural(a.pending, 'mail')} still to fetch` : '';
  return { word: a.pending ? 'Fetching' : 'Up to date', tone: a.pending ? 'working' : 'ready', detail: synced + pending };
}
