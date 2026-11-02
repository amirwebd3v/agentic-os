import { createApp } from 'vue';
import { afterEach, expect, test, vi } from 'vitest';
import type { MailOverview, SenderGroup } from '../src/api';
import { gmailLink } from '../src/api';
import MailSorting from '../src/components/MailSorting.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const EVIL = '<img src=x onerror="alert(1)">';
const overview = (over: Partial<MailOverview> = {}): MailOverview => ({
  calibration: { done: 37, total: 200, calibrating: true },
  categories: [
    { id: 1, name: 'Blog ideas', system: null, count: 2 },
    { id: 5, name: 'Personal', system: 'personal', count: 1 },
  ],
  needs_sorting: 2,
  rules: [],
  ...over,
});
const group = (over: Partial<SenderGroup> = {}): SenderGroup => ({
  sender: 'news@example.com',
  suggestion_id: 1,
  mails: [
    { id: 11, gmail_id: 'g11', sender: 'news@example.com', subject: EVIL, internal_date: '2026-11-01T10:00:00.000Z', account: 'a@example.com' },
    { id: 12, gmail_id: 'g12', sender: 'news@example.com', subject: 'Issue 5', internal_date: '2026-11-02T10:00:00.000Z', account: 'a@example.com' },
  ],
  ...over,
});

async function mount(o = overview(), groups = [group()]) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    calls.push(`${init.method} ${path}`);
    if (init.body) bodies.push(JSON.parse(init.body as string));
    if (path.endsWith('/overview')) return Response.json(o);
    if (path.endsWith('/needs-sorting')) return Response.json({ groups });
    if (path.includes('/mails') && init.method === 'GET') return Response.json({ mails: [] });
    return Response.json({ moved: 2, ok: true });
  }));
  const el = document.createElement('div');
  document.body.append(el);
  createApp(MailSorting).mount(el);
  await vi.waitFor(() => expect(el.textContent).toContain('Categories'));
  return { el, calls, bodies };
}
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text))!;

test('calibration shows the count, mail text renders as text, and links are built from ids', async () => {
  const { el } = await mount();
  expect(el.textContent).toContain('Sorting 37 of 200');
  expect(el.querySelector('img')).toBeNull();
  expect(el.textContent).toContain(EVIL);
  const link = el.querySelector('.mails a') as HTMLAnchorElement;
  expect(link.getAttribute('href')).toBe('https://mail.google.com/mail/?authuser=a%40example.com#all/g11');
  expect(link.rel).toContain('noopener');
});

test('sorting a group uses the suggestion; just this mail sorts one; neither makes a rule', async () => {
  const { el, calls, bodies } = await mount();
  button(el, 'Just this mail').click();
  await vi.waitFor(() => expect(calls).toContain('POST /api/email/mails/11/sort'));
  expect(calls).not.toContain('POST /api/email/mails/12/sort');
  expect(bodies[0]).toEqual({ category_id: 1 });
  await vi.waitFor(() => expect(button(el, 'Sort these 2').disabled).toBe(false));
  button(el, 'Sort these 2').click();
  await vi.waitFor(() => expect(calls).toContain('POST /api/email/mails/12/sort'));
});

test('always this sender says what it moved', async () => {
  const { el, bodies } = await mount();
  button(el, 'Always this sender').click();
  await vi.waitFor(() => expect(el.textContent).toContain('2 mails moved'));
  expect(bodies[0]).toEqual({ category_id: 1, always: true, apply_stored: true });
});

test('with no suggestion the buttons wait for a choice, and unread mail offers no rule', async () => {
  const { el } = await mount(overview(), [group({ sender: null, suggestion_id: null })]);
  expect(button(el, 'Sort these 2').disabled).toBe(true);
  expect(el.textContent).toContain('could not be read');
  expect(button(el, 'Always this sender')).toBeUndefined();
});

test('removing a category asks first; Personal cannot be removed', async () => {
  const { el, calls } = await mount();
  const rows = [...el.querySelectorAll('.categories > li')] as HTMLElement[];
  expect(button(rows[1]!, 'Remove')).toBeUndefined();
  button(rows[0]!, 'Remove').click();
  await vi.waitFor(() => expect(el.textContent).toContain('Its mail moves to Needs sorting'));
  expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
});

test('empty: nothing waiting, no calibration notice once done', async () => {
  const { el } = await mount(overview({ calibration: { done: 200, total: 200, calibrating: false }, needs_sorting: 0 }), []);
  expect(el.textContent).toContain('Nothing is waiting');
  expect(el.textContent).not.toContain('Sorting 200');
});

test('consent off says nothing goes to Claude; the switch asks the server', async () => {
  const { el, calls, bodies } = await mount(overview({ consent: false }));
  expect(el.textContent).toContain('Nothing from your mail goes to Claude');
  button(el, 'Allow Claude analysis').click();
  await vi.waitFor(() => expect(calls).toContain('PUT /api/email/settings'));
  expect(bodies[0]).toEqual({ consent: true });
});

test('a paragraph renders as text with its age, sources, cost and marks', async () => {
  const paragraph = { text: EVIL, cites: [1, 2], created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(), cost_usd: 0.0123, source_removed: true, refresh_failed: true };
  const { el } = await mount(overview({ consent: true, provider_ok: false, categories: [{ id: 1, name: 'Blog ideas', system: null, count: 2, paragraph }] }));
  expect(el.querySelector('img')).toBeNull();
  expect(el.textContent).toContain(EVIL);
  expect(el.textContent).toContain('3h old · from 2 mails · cost $0.012 · couldn\'t refresh · a source was removed');
  expect(el.textContent).toContain("isn't one mail may go to");
});

test('a Gmail link escapes its parts', () => {
  expect(gmailLink({ gmail_id: 'a/b', account: 'x y@example.com' })).toBe('https://mail.google.com/mail/?authuser=x%20y%40example.com#all/a%2Fb');
});
