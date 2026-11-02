import { createApp, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { MailAccounts, MailOverview } from '../src/api';
import EmailArea from '../src/components/EmailArea.vue';
import MailIdeas from '../src/components/MailIdeas.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const EVIL = '<img src=x onerror="alert(1)">';
const account = (over = {}) => ({ id: 1, email: 'a@example.com', status: 'connected' as const, backfill_done: 1 as const, last_synced_at: new Date().toISOString(), ...over });
const overview = (over: Partial<MailOverview> = {}): MailOverview => ({
  calibration: { done: 389, total: 200, calibrating: false },
  consent: true,
  categories: [
    { id: 1, name: 'Blog ideas', system: null, count: 4, paragraph: { text: EVIL, cites: [1], created_at: new Date().toISOString(), cost_usd: 0.004, source_removed: false, refresh_failed: false } },
    { id: 3, name: 'Career', system: null, count: 0, paragraph: null },
    { id: 5, name: 'Personal', system: 'personal', count: 7 },
  ],
  needs_sorting: 12,
  rules: [],
  ...over,
});

function mount(component: object, props: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`);
    return Response.json({ saved: true, path: 'ideas/2026-11-02-blog-ideas-abc.md' });
  }));
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  const el = document.createElement('div');
  document.body.append(el);
  createApp({ render: () => h(component, props) }).use(router).mount(el);
  return { el, calls };
}
const accounts = (list: ReturnType<typeof account>[]): MailAccounts => ({ setup: true, flow: 'idle', accounts: list });

test('the area: not connected says so; connected leads with what needs you', () => {
  expect(mount(EmailArea, { accounts: accounts([]), overview: null, failed: false }).el.textContent).toContain('Not connected');
  document.body.innerHTML = '';
  const { el } = mount(EmailArea, { accounts: accounts([account()]), overview: overview(), failed: false });
  expect(el.querySelector('.big')!.textContent).toMatch(/12\s*to sort/);
  expect(el.textContent).toContain('Claude analysis on');
  expect(el.querySelector('a')!.getAttribute('href')).toBe('/email');
});

test('the area names a problem before the rest', () => {
  const { el } = mount(EmailArea, { accounts: accounts([account({ status: 'reconnect' })]), overview: overview(), failed: false });
  expect(el.querySelector('.problem')!.textContent).toBe('An account needs reconnecting');
});

test('ideas: one paragraph per category, as text, with Save idea; the rest in one line', async () => {
  const { el, calls } = mount(MailIdeas, { overview: overview() });
  expect(el.querySelector('img')).toBeNull();
  expect(el.querySelectorAll('.idea')).toHaveLength(1);
  expect(el.textContent).toContain(EVIL);
  expect(el.textContent).toContain('Nothing new this week in Career');
  expect(el.textContent).not.toContain('Personal');
  expect(el.querySelector('.idea h3 a')!.getAttribute('href')).toBe('/email?view=1');
  [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Save idea'))!.click();
  await vi.waitFor(() => expect(el.textContent).toContain('Saved to ideas/2026-11-02-blog-ideas-abc.md'));
  expect(calls).toContain('POST /api/email/categories/1/ideas');
});

test('ideas with consent off say why there are none', () => {
  const { el } = mount(MailIdeas, { overview: overview({ consent: false }) });
  expect(el.textContent).toContain('Claude analysis is off');
});
