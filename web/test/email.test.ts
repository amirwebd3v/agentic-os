import { createApp } from 'vue';
import { afterEach, expect, test, vi } from 'vitest';
import type { MailAccounts } from '../src/api';
import EmailView from '../src/views/EmailView.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const EVIL = '<img src=x onerror="alert(1)">@example.com';
const account = (over = {}) => ({ id: 1, email: 'a@example.com', status: 'connected' as const, backfill_done: 0 as const, last_synced_at: null, ...over });

async function mount(first: MailAccounts) {
  let current = first;
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    calls.push(`${init.method} ${path}`);
    if (path.endsWith('/overview')) return Response.json({ calibration: { done: 0, total: 200, calibrating: true }, categories: [], needs_sorting: 0, rules: [] });
    if (path.endsWith('/needs-sorting')) return Response.json({ groups: [] });
    if (init.method === 'GET') return Response.json(current);
    if (init.method === 'DELETE') return Response.json({ revoked: false });
    return Response.json({ url: 'https://accounts.example/auth' });
  }));
  const el = document.createElement('div');
  document.body.append(el);
  createApp(EmailView).mount(el);
  await vi.waitFor(() => expect(el.querySelector('h1')).not.toBeNull());
  await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r));
  return { el, calls, set: (next: MailAccounts) => (current = next) };
}
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text));

test('without the Google client it shows the steps, and the connect button stays off', async () => {
  const { el } = await mount({ setup: false, flow: 'idle', accounts: [] });
  expect(el.textContent).toContain('pnpm secrets set gmail_client_id');
  expect(button(el, 'Connect Gmail')).toBeUndefined();
});

test('connect opens Google in a new tab and shows the result', async () => {
  const { el, set } = await mount({ setup: true, flow: 'idle', accounts: [] });
  const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
  vi.stubGlobal('open', vi.fn(() => tab));
  set({ setup: true, flow: 'wrong_scope', accounts: [] });
  button(el, 'Connect Gmail')!.click();
  await vi.waitFor(() => expect(el.textContent).toContain('refused and revoked'));
  expect(tab.location.href).toBe('https://accounts.example/auth');
  expect(tab.opener).toBeNull();
});

test('account text renders as text; disconnect asks first, then reports a failed revoke', async () => {
  const { el, calls } = await mount({ setup: true, flow: 'idle', accounts: [account({ email: EVIL })] });
  expect(el.querySelector('img')).toBeNull();
  expect(el.textContent).toContain(EVIL);
  expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  button(el, 'Disconnect')!.click();
  await vi.waitFor(() => expect(button(el, 'Disconnect, keep local mail')).toBeDefined());
  button(el, 'Disconnect, keep local mail')!.click();
  await vi.waitFor(() => expect(calls).toContain('DELETE /api/email/accounts/1?keep=1'));
  await vi.waitFor(() => expect(el.textContent).toContain('Google could not be reached'));
});

test('an account needing a reconnect says so and offers it', async () => {
  const { el } = await mount({ setup: true, flow: 'idle', accounts: [account({ status: 'reconnect' })] });
  expect(el.textContent).toContain('Needs reconnecting');
  expect(button(el, 'Reconnect')).toBeDefined();
});
