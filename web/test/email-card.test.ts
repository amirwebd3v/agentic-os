import { createApp, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { MailOverview } from '../src/api';
import MailIdeas from '../src/components/MailIdeas.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const EVIL = '<img src=x onerror="alert(1)">';
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

function mount(props: { overview: MailOverview }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`);
    return Response.json({ saved: true, path: 'ideas/2026-11-02-blog-ideas-abc.md' });
  }));
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  const el = document.createElement('div');
  document.body.append(el);
  createApp({ render: () => h(MailIdeas, props) }).use(router).mount(el);
  return { el, calls };
}

test('ideas: one paragraph per category, as text, with Save idea; the rest in one line', async () => {
  const { el, calls } = mount({ overview: overview() });
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
  const { el } = mount({ overview: overview({ consent: false }) });
  expect(el.textContent).toContain('Claude analysis is off');
});
