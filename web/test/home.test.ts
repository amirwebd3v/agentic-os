import { createApp } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { ApplicationListItem, Dashboard } from '../src/api';
import { nextStep } from '../src/stores/career';
import HomeView from '../src/views/HomeView.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const item = (over: Partial<ApplicationListItem>): ApplicationListItem => ({
  id: 1, company: 'Acme', role_title: 'Engineer', language: 'en', status: 'draft_ready', step: null, fail_code: null,
  follow_up_on: null, created_at: '2026-10-28T00:00:00Z', updated_at: '2026-10-28T00:00:00Z', archived_at: null,
  last_milestone: null, last_milestone_on: null, next_interview: null, ...over,
});

test('every state lands in one group with its next step in words', () => {
  const day = '2026-10-29';
  const group = (over: Partial<ApplicationListItem>) => nextStep(item(over), day).group;
  expect(group({ status: 'processing', step: 'draft' })).toBe('progress');
  expect(group({ status: 'final', step: 'render' })).toBe('progress');
  expect(group({ status: 'failed' })).toBe('needs');
  expect(group({ status: 'needs_answers' })).toBe('needs');
  expect(group({ status: 'final', fail_code: 'render_failed' })).toBe('needs');
  expect(group({ status: 'final' })).toBe('needs'); // the app never sends: you do, then mark it applied
  expect(group({ status: 'applied', follow_up_on: '2026-10-29' })).toBe('follow');
  expect(group({ status: 'applied', follow_up_on: '2026-11-29' })).toBe('done');
  expect(nextStep(item({ status: 'applied', follow_up_on: '2026-10-20' }), day).text).toMatch(/^Follow up, due /);
});

const DASH: Dashboard = {
  ai: {
    days: Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, calls: i % 3, input_tokens: i * 1000, output_tokens: i * 100, failures: i === 4 ? 1 : 0, cost: i * 0.01 })),
    by_pipeline: [{ pipeline: 'career_draft', calls: 12, input_tokens: 9000, output_tokens: 900, cost: 0.2 }, { pipeline: 'career_intake', calls: 20, input_tokens: 4000, output_tokens: 400, cost: 0.05 }],
    totals: { calls: 32, input_tokens: 13000, output_tokens: 1300, failures: 1, cost: 0.25 }, priced: true,
  },
  system: { provider: 'ok', approvals_pending: 2, jobs: { queued: 1, running: 0, failed_7d: 3 }, vault_notes: 41, last_vault_commit: null },
  areas: {
    career: { by_status: { draft_ready: 2, applied: 3 }, archived: 1, new_this_week: 2, needs_you: 2, master: { exists: true, entries: 4, lines: 37 } },
    email: { connected: false }, social: { connected: false },
  },
};

function mountHome(routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => (path in routes ? Response.json(routes[path]) : Response.json({}, { status: 404 }))));
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  const el = document.createElement('div');
  document.body.append(el);
  createApp(HomeView).use(router).mount(el);
  return el;
}
const MAIL = '/api/email';

// Home became a command center (owner's decision, 2026-11-02): it lists the applications that need you, which
// career-v2 §6 had kept off Home.
test('the overview leads with what needs you, most urgent first, then health, figures and usage', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const el = mountHome({
    '/api/dashboard': DASH,
    '/api/career/applications': [item({ id: 7, company: 'Acme', status: 'draft_ready' }), item({ id: 8, company: 'Hawk', status: 'applied', follow_up_on: today }), item({ id: 9, company: 'Old', status: 'applied' })],
    [`${MAIL}/accounts`]: { setup: true, flow: 'idle', accounts: [{ id: 1, email: 'a@example.com', status: 'reconnect', backfill_done: 1, last_synced_at: null }] },
    [`${MAIL}/overview`]: { calibration: { done: 10, total: 200, calibrating: true }, consent: false, categories: [], needs_sorting: 4, rules: [] },
  });
  await vi.waitFor(() => expect(el.querySelectorAll('.queue .item').length).toBe(5));
  const queue = [...el.querySelectorAll('.queue .item .title')].map((t) => t.textContent);
  expect(queue[0]).toBe('1 account needs reconnecting');
  expect(queue).toEqual(expect.arrayContaining(['Acme · Engineer', 'Hawk · Engineer', '4 mails to sort', '2 items waiting in Review']));
  expect(queue).not.toContain('Old · Engineer');
  expect(el.querySelector('.queue a[href="/applications/7"]')).not.toBeNull();
  expect(el.querySelector('.status-line')!.textContent).toContain('5 things need you');
  expect(el.querySelector('.health')!.textContent).toContain('3 failed');
  expect(el.querySelector('.health')!.textContent).toContain('1 to reconnect');
  const strip = el.querySelector('.strip')!.textContent!;
  for (const figure of ['32', '$0.25', '3% failed', '37']) expect(strip).toContain(figure);
  expect(el.querySelectorAll('.cols .col')).toHaveLength(30);
  expect(el.querySelector('.calls .rowbars li')!.textContent).toContain('career_intake'); // most calls first
  expect(el.textContent).not.toContain('Show as a table'); // charts have no table toggle (#74)
  expect(el.querySelector('.cols .col')!.getAttribute('aria-label')).toMatch(/: /); // values stay readable to screen readers
});

test('nothing needs you: the queue says so, and a source that fails hides nothing else', async () => {
  const el = mountHome({ '/api/dashboard': { ...DASH, system: { ...DASH.system, approvals_pending: 0, jobs: { queued: 0, running: 0, failed_7d: 0 } } }, '/api/career/applications': [] });
  await vi.waitFor(() => expect(el.querySelector('.queue .calm')).not.toBeNull());
  expect(el.querySelector('.status-line')!.textContent).toContain('Nothing needs you');
  expect(el.querySelector('.status-line')!.textContent).toContain('everything is working');
  expect(el.querySelector('.health')!.textContent).toContain('Not connected');
  await vi.waitFor(() => expect(el.textContent).toMatch(/mail summary didn.t load/)); // the mail part failed, alone
  expect(el.querySelector('.strip')!.textContent).toContain('32');
});
