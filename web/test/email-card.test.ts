import { createApp } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { MailAccounts, MailOverview } from '../src/api';
import EmailCard from '../src/components/EmailCard.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const EVIL = '<img src=x onerror="alert(1)">';
const account = { id: 1, email: 'a@example.com', status: 'connected' as const, backfill_done: 1 as const, last_synced_at: null };
const overview = (over: Partial<MailOverview> = {}): MailOverview => ({
  calibration: { done: 200, total: 200, calibrating: false },
  consent: true,
  categories: [
    { id: 1, name: 'Blog ideas', system: null, count: 4, paragraph: { text: EVIL, cites: [1], created_at: new Date().toISOString(), cost_usd: 0.004, source_removed: false, refresh_failed: false } },
    { id: 3, name: 'Career', system: null, count: 0, paragraph: null },
    { id: 5, name: 'Personal', system: 'personal', count: 7 },
    { id: 6, name: 'Noise', system: 'noise', count: 30 },
  ],
  needs_sorting: 2,
  rules: [],
  ...over,
});

async function mount(accounts: MailAccounts, o = overview()) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    calls.push(`${init.method} ${path}`);
    if (path.endsWith('/accounts')) return Response.json(accounts);
    if (path.endsWith('/overview')) return Response.json(o);
    return Response.json({ saved: true, path: 'ideas/2026-11-02-blog-ideas-abc.md' });
  }));
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  const el = document.createElement('div');
  document.body.append(el);
  createApp(EmailCard).use(router).mount(el);
  await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 10));
  return { el, calls };
}
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text))!;

test('never connected: says so, links to connect, and asks for no overview', async () => {
  const { el, calls } = await mount({ setup: true, flow: 'idle', accounts: [] });
  expect(el.textContent).toContain('Not connected');
  expect(calls).toEqual(['GET /api/email/accounts']);
});

test('status and one paragraph per idea category; Personal and Noise are counts only', async () => {
  const { el } = await mount({ setup: true, flow: 'idle', accounts: [account] });
  expect(el.querySelector('img')).toBeNull();
  expect(el.textContent).toContain(EVIL);
  expect(el.textContent).toContain('2 mails need sorting');
  expect(el.textContent).toContain('Nothing new.');
  expect(el.textContent).toContain('Personal: 7 · Noise: 30');
  expect(el.querySelectorAll('.para')).toHaveLength(1);
});

test('save idea says where it went', async () => {
  const { el, calls } = await mount({ setup: true, flow: 'idle', accounts: [account] });
  button(el, 'Save idea').click();
  await vi.waitFor(() => expect(el.textContent).toContain('Saved to ideas/2026-11-02-blog-ideas-abc.md'));
  expect(calls).toContain('POST /api/email/categories/1/ideas');
});

test('reconnect, classifier down, calibration and consent off each say so', async () => {
  const { el } = await mount(
    { setup: true, flow: 'idle', accounts: [{ ...account, status: 'reconnect' }, { ...account, id: 2, triage_error: 'classifier_down' }] },
    overview({ consent: false, calibration: { done: 37, total: 200, calibrating: true }, categories: [{ id: 3, name: 'Career', system: null, count: 0, paragraph: null }] }),
  );
  expect(el.textContent).toContain('An account needs reconnecting');
  expect(el.textContent).toContain('The classifier is down');
  expect(el.textContent).toContain('Sorting 37 of 200');
  expect(el.textContent).toContain('Claude analysis is off');
});
