import { createPinia, setActivePinia } from 'pinia';
import { createApp } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { ApplicationListItem } from '../src/api';
import { nextStep, today } from '../src/stores/career';
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

test('every state lands in one Home group with its next step in words', () => {
  const day = '2026-10-29';
  const group = (over: Partial<ApplicationListItem>) => nextStep(item(over), day).group;
  expect(group({ status: 'processing', step: 'draft' })).toBe('progress');
  expect(group({ status: 'final', step: 'render' })).toBe('progress');
  expect(group({ status: 'failed' })).toBe('needs');
  expect(group({ status: 'final', fail_code: 'render_failed' })).toBe('needs');
  expect(group({ status: 'flagged' })).toBe('needs');
  expect(group({ status: 'final' })).toBe('needs'); // the app never sends: you do, then mark it applied
  expect(group({ status: 'applied', follow_up_on: '2026-10-29' })).toBe('follow');
  expect(group({ status: 'applied', follow_up_on: '2026-11-29' })).toBe('done');
  expect(group({ status: 'withdrawn', follow_up_on: '2026-10-01' })).toBe('done');
  expect(nextStep(item({ status: 'applied', follow_up_on: '2026-10-20' }), day).text).toMatch(/^Follow up, due /);
});

test('Home lists what needs you first, hides archived ones, and marks an application applied inline', async () => {
  const EVIL = '<img src=x onerror="alert(1)">';
  const calls: { key: string; body: unknown }[] = [];
  const list = [
    item({ id: 1, status: 'final', role_title: EVIL }),
    item({ id: 2, status: 'processing', step: 'match' }),
    item({ id: 3, status: 'failed', archived_at: '2026-10-28T00:00:00Z', role_title: 'Hidden' }),
  ];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    const key = `${init.method} ${path}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body as string) : undefined });
    if (key === 'GET /api/career/applications') return Response.json(list);
    if (key === 'GET /api/career/master') return Response.json({ exists: false });
    if (key === 'POST /api/career/applications/1/milestones') return Response.json({});
    return Response.json({ error: 'not_found' }, { status: 404 });
  }));
  setActivePinia(createPinia());
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  const el = document.createElement('div');
  document.body.append(el);
  createApp(HomeView).use(router).mount(el);
  await vi.waitFor(() => expect(el.querySelector('#needs-title')!.textContent).toContain('1'));
  expect(el.textContent).toContain('Start with your master CV');
  expect(el.querySelector('#progress-title')).not.toBeNull();
  expect(el.textContent).not.toContain('Hidden');
  expect(el.querySelector('img')).toBeNull();
  [...el.querySelectorAll('button')].find((b) => b.textContent === 'Mark applied today')!.click();
  await vi.waitFor(() => expect(calls.some((c) => c.key.startsWith('POST'))).toBe(true));
  expect(calls.find((c) => c.key.startsWith('POST'))!.body).toEqual({ kind: 'applied', on_date: today(), note: '' });
});
