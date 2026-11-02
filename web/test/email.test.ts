import { createApp, nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Router } from 'vue-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { MailAccounts, MailOverview, SenderGroup } from '../src/api';
import { gmailLink } from '../src/api';
import EmailView from '../src/views/EmailView.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const EVIL = '<img src=x onerror="alert(1)">';
const account = (over = {}) => ({ id: 1, email: 'a@example.com', status: 'connected' as const, backfill_done: 1 as const, last_synced_at: new Date().toISOString(), ...over });
const overview = (over: Partial<MailOverview> = {}): MailOverview => ({
  calibration: { done: 389, total: 200, calibrating: false },
  consent: true,
  provider_ok: true,
  categories: [
    { id: 1, name: 'Blog ideas', system: null, count: 2, paragraph: { text: EVIL, cites: [1], created_at: new Date().toISOString(), cost_usd: 0.004, source_removed: false, refresh_failed: false } },
    { id: 5, name: 'Personal', system: 'personal', count: 1, paragraph: null },
  ],
  needs_sorting: 2,
  rules: [{ sender: 'deals@shop.example', category_id: 5, learned: 1 }, { sender: '#abc', category_id: 5, learned: 1 }],
  ...over,
});
const groups: SenderGroup[] = [
  { sender: 'news@example.com', suggestion_id: 1, mails: [{ id: 11, gmail_id: 'g11', sender: 'news@example.com', subject: EVIL, internal_date: '2026-11-01T10:00:00.000Z', account: 'a@example.com' }, { id: 12, gmail_id: 'g12', sender: 'news@example.com', subject: 'Issue 5', internal_date: '2026-11-02T10:00:00.000Z', account: 'a@example.com' }] },
  { sender: null, suggestion_id: null, mails: [{ id: 13, gmail_id: 'g13', sender: null, subject: null, internal_date: '2026-11-02T10:00:00.000Z', account: 'a@example.com' }] },
];

async function mount(accounts: MailAccounts, o: MailOverview = overview(), path = '/email') {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`);
    if (init.body) bodies.push(JSON.parse(init.body as string));
    if (url.endsWith('/accounts')) return Response.json(accounts);
    if (url.endsWith('/overview')) return Response.json(o);
    if (url.endsWith('/needs-sorting')) return Response.json({ groups });
    if (url.includes('/mails') && init.method === 'GET') return Response.json({ mails: [{ id: 1, gmail_id: 'c1', sender: 'x@example.com', subject: 'Local-first', internal_date: '2026-11-01T00:00:00.000Z', account: 'a@example.com' }] });
    if (init.method === 'DELETE' && url.includes('/accounts/')) return Response.json({ revoked: false });
    return Response.json({ url: 'https://accounts.example/auth', moved: 2, ok: true, queued: 1, saved: true, path: 'ideas/x.md' });
  }));
  const router: Router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/email', component: EmailView }] });
  await router.push(path);
  const el = document.createElement('div');
  document.body.append(el);
  createApp({ template: '<RouterView />' }).use(router).mount(el);
  await vi.waitFor(() => expect(el.querySelector('h1')).not.toBeNull());
  await new Promise((r) => setTimeout(r, 20));
  return { el, calls, bodies, router };
}
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text));

test('without the Google client it shows the steps', async () => {
  const { el } = await mount({ setup: false, flow: 'idle', accounts: [] });
  expect(el.textContent).toContain('pnpm secrets set gmail_client_id');
});

test('first run explains, and Connect opens Google in a new tab and reports the result', async () => {
  const { el } = await mount({ setup: true, flow: 'wrong_scope', accounts: [] });
  const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
  vi.stubGlobal('open', vi.fn(() => tab));
  button(el, 'Connect Gmail')!.click();
  await vi.waitFor(() => expect(el.textContent).toContain('refused and revoked'));
  expect(tab.location.href).toBe('https://accounts.example/auth');
  expect(tab.opener).toBeNull();
});

test('the title row leads with what needs you, then the rest', async () => {
  const { el } = await mount({ setup: true, flow: 'idle', accounts: [account(), account({ id: 2, email: 'b@example.com', status: 'reconnect' })] });
  const line = el.querySelector('.status-line')!.textContent!;
  expect(line.indexOf('1 account needs reconnecting')).toBeLessThan(line.indexOf('2 mails to sort'));
  expect(line).toContain('Claude analysis on');
});

test('three columns: views with counts, the open view, and the status rail', async () => {
  const { el } = await mount({ setup: true, flow: 'idle', accounts: [account()] });
  expect(el.querySelector('nav.views')!.textContent).toMatch(/Needs sorting\s*2/);
  expect(el.querySelector('nav.views')!.textContent).toMatch(/Blog ideas\s*2/);
  expect(el.querySelector('.view h2')!.textContent).toBe('Needs sorting');
  expect(el.querySelector('.rail')!.textContent).toContain('Up to date');
  expect(el.querySelector('.rail')!.textContent).toMatch(/Sorted by you\s*389/); // label first for screen readers; CSS sets the figure on top
});

test('mail text renders as text, links are built from ids, and an unread group offers no rule', async () => {
  const { el } = await mount({ setup: true, flow: 'idle', accounts: [account()] });
  await vi.waitFor(() => expect(el.textContent).toContain('news@example.com'));
  expect(el.querySelector('img')).toBeNull();
  expect(el.textContent).toContain(EVIL);
  expect(el.querySelector('.mails a')!.getAttribute('href')).toBe('https://mail.google.com/mail/?authuser=a%40example.com#all/g11');
  const groupsEl = [...el.querySelectorAll('.group')] as HTMLElement[];
  expect(button(groupsEl[1]!, 'Always')).toBeUndefined();
  expect((groupsEl[1]!.querySelector('select') as HTMLSelectElement).value).toBe('');
  expect(button(groupsEl[1]!, 'File it')!.disabled).toBe(true);
});

test('filing uses the suggestion, Only this files one, and Always also makes a rule', async () => {
  const { el, calls, bodies } = await mount({ setup: true, flow: 'idle', accounts: [account()] });
  await vi.waitFor(() => expect(button(el, 'File all 2')).toBeDefined());
  button(el, 'Only this')!.click();
  await vi.waitFor(() => expect(calls).toContain('POST /api/email/mails/11/sort'));
  expect(bodies[0]).toEqual({ category_id: 1 });
  await vi.waitFor(() => expect(button(el, 'Always')!.disabled).toBe(false));
  button(el, 'Always')!.click();
  await vi.waitFor(() => expect(el.textContent).toContain('2 mails moved'));
  expect(bodies.at(-1)).toEqual({ category_id: 1, always: true, apply_stored: true });
});

test('a category opens from the views, leads with its paragraph, and saves an idea', async () => {
  const { el, calls, router } = await mount({ setup: true, flow: 'idle', accounts: [account()] });
  button(el, 'Blog ideas')!.click();
  await vi.waitFor(() => expect(router.currentRoute.value.query['view']).toBe('1'));
  await vi.waitFor(() => expect(el.querySelector('.view h2')!.textContent).toBe('Blog ideas'));
  const paragraph = el.querySelector('.paragraph')!;
  expect(paragraph.textContent).toContain(EVIL);
  expect(el.querySelector('.paragraph')!.compareDocumentPosition(el.querySelector('.mail-table')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  button(el, 'Save idea')!.click();
  await vi.waitFor(() => expect(el.textContent).toContain('Saved to ideas/x.md'));
  expect(calls).toContain('POST /api/email/categories/1/ideas');
});

test('the view survives a reload through the URL; Personal says what it keeps; removing asks first', async () => {
  const { el, calls } = await mount({ setup: true, flow: 'idle', accounts: [account()] }, overview(), '/email?view=5');
  await vi.waitFor(() => expect(el.querySelector('.view h2')!.textContent).toBe('Personal'));
  expect(el.textContent).toContain('kept as dates only');
  expect(button(el.querySelector('.view')!, 'Remove')).toBeUndefined();
  const { el: el2 } = await mount({ setup: true, flow: 'idle', accounts: [account()] }, overview(), '/email?view=1');
  await vi.waitFor(() => expect(button(el2.querySelector('.view')!, 'Remove')).toBeDefined());
  button(el2.querySelector('.view')!, 'Remove')!.click();
  await nextTick();
  expect(el2.textContent).toContain('Its mail goes back to Needs sorting');
  expect(calls.some((c) => c.startsWith('DELETE /api/email/categories'))).toBe(false);
});

test('sender rules: hashed Personal senders stay hidden, learned rules say Stop', async () => {
  const { el } = await mount({ setup: true, flow: 'idle', accounts: [account()] }, overview(), '/email?view=rules');
  await vi.waitFor(() => expect(el.querySelector('.view h2')!.textContent).toBe('Sender rules'));
  expect(el.textContent).toContain('Personal sender (address hidden)');
  expect(el.textContent).not.toContain('#abc');
  expect(button(el.querySelector('.view')!, 'Stop')).toBeDefined();
});

test('the rail: disconnect asks first and reports a failed revoke; consent off says nothing goes out', async () => {
  const { el, calls } = await mount({ setup: true, flow: 'idle', accounts: [account()] }, overview({ consent: false }));
  expect(el.querySelector('.rail')!.textContent).toContain('Nothing from your mail goes to Claude');
  button(el.querySelector('.rail')!, 'Disconnect')!.click();
  await nextTick();
  button(el.querySelector('.rail')!, 'Disconnect, keep its mail')!.click();
  await vi.waitFor(() => expect(calls).toContain('DELETE /api/email/accounts/1?keep=1'));
  await vi.waitFor(() => expect(el.textContent).toContain('Google could not be reached'));
});

test('a paused account says why, and what to do', async () => {
  const { el } = await mount({ setup: true, flow: 'idle', accounts: [account({ triage_error: 'classifier_down' })] });
  expect(el.querySelector('.status-line')!.textContent).toContain('Sorting paused');
  expect(el.querySelector('.rail')!.textContent).toContain('Start the app with pnpm dev');
});

test('a Gmail link escapes its parts', () => {
  expect(gmailLink({ gmail_id: 'a/b', account: 'x y@example.com' })).toBe('https://mail.google.com/mail/?authuser=x%20y%40example.com#all/a%2Fb');
});
