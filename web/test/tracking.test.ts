import { createPinia, setActivePinia } from 'pinia';
import { createApp, type Component } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { ApplicationDetail, ApplicationListItem, Milestone } from '../src/api';
import ApplicationsView from '../src/views/ApplicationsView.vue';
import ApplicationView from '../src/views/ApplicationView.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const EVIL = '<img src=x onerror="alert(1)">';
const ms = (id: number, kind: Milestone['kind'], on_date: string, note: string | null = null): Milestone =>
  ({ id, kind, on_date, note, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });
const app = (over: Partial<ApplicationDetail> = {}): ApplicationDetail => ({
  id: 1, company: 'Acme', role_title: 'Engineer', language: null, status: 'applied', step: null, fail_code: null,
  follow_up_on: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  requirements: null, coverage: null, draft: null, edited_refs: [], verify: null, sources: {}, languages: [], files: [],
  milestones: [ms(7, 'applied', '2026-10-01', EVIL), ms(8, 'interview', '2099-01-05')],
  ...over,
});

function api(routes: Record<string, (body: unknown) => unknown>) {
  const calls: { key: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    const key = `${init.method} ${path}`;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ key, body });
    const handler = routes[key];
    return handler ? Response.json(handler(body)) : Response.json({ error: 'not_found' }, { status: 404 });
  }));
  return calls;
}

async function mount(view: Component, props: Record<string, unknown> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  const el = document.createElement('div');
  document.body.append(el);
  createApp(view, props).use(pinia).use(router).mount(el);
  await vi.waitFor(() => expect(el.querySelector('h1')).not.toBeNull());
  return { el, router };
}
const set = (field: Element, value: string) => {
  (field as HTMLInputElement).value = value;
  field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input'));
};
const submit = (form: Element) => form.dispatchEvent(new Event('submit'));

test('the timeline shows kinds and dates in words and the note as text; it waits for the draft to be final', async () => {
  api({ 'GET /api/career/applications/1': () => app() });
  const { el } = await mount(ApplicationView, { id: '1' });
  await vi.waitFor(() => expect(el.querySelector('.timeline')).not.toBeNull());
  const items = [...el.querySelectorAll('.timeline > li')].map((li) => li.textContent);
  expect(items[0]).toContain('Applied');
  expect(items[0]).toContain(EVIL);
  expect(items[1]).toContain('Interview');
  expect(items[1]).toContain('Upcoming');
  expect(el.querySelector('.timeline time')?.getAttribute('datetime')).toBe('2026-10-01');
  expect(el.querySelector('img')).toBeNull();

  document.body.innerHTML = '';
  api({ 'GET /api/career/applications/1': () => app({ status: 'draft_ready' }) });
  const draft = await mount(ApplicationView, { id: '1' });
  expect(draft.el.querySelector('.tracking')).toBeNull();
});

test('add, edit (Esc cancels) and delete milestones, and set the follow-up date', async () => {
  const calls = api({
    'GET /api/career/applications/1': () => app(),
    'POST /api/career/applications/1/milestones': () => app({ milestones: [...app().milestones, ms(9, 'feedback', '2026-10-12', 'Call went well')] }),
    'PATCH /api/career/applications/1/milestones/8': () => app({ milestones: [app().milestones[0]!, ms(8, 'interview', '2099-01-06')] }),
    'DELETE /api/career/applications/1/milestones/7': () => app({ milestones: [app().milestones[1]!] }),
    'PATCH /api/career/applications/1': (b) => app({ follow_up_on: (b as { follow_up_on: string | null }).follow_up_on }),
  });
  const { el } = await mount(ApplicationView, { id: '1' });
  await vi.waitFor(() => expect(el.querySelector('.tracking')).not.toBeNull());

  const addForm = el.querySelector('form[aria-label="Add to the timeline"]')!;
  set(addForm.querySelector('select')!, 'feedback');
  set(addForm.querySelector('input[type="date"]')!, '2026-10-12');
  set(addForm.querySelector('textarea')!, 'Call went well');
  submit(addForm);
  await vi.waitFor(() => expect(el.textContent).toContain('Call went well'));
  expect(calls.find((c) => c.key.startsWith('POST'))!.body).toEqual({ kind: 'feedback', on_date: '2026-10-12', note: 'Call went well' });
  expect((addForm.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');

  const editButton = () => el.querySelector('[aria-label^="Edit Interview"]') as HTMLButtonElement;
  editButton().click();
  await vi.waitFor(() => expect(document.activeElement?.tagName).toBe('SELECT'));
  el.querySelector('.timeline form')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await vi.waitFor(() => expect(document.activeElement).toBe(editButton()));
  expect(el.querySelector('.timeline form')).toBeNull();

  editButton().click();
  await vi.waitFor(() => expect(el.querySelector('.timeline form')).not.toBeNull());
  set(el.querySelector('.timeline form input[type="date"]')!, '2099-01-06');
  submit(el.querySelector('.timeline form')!);
  await vi.waitFor(() => expect(el.querySelector('.timeline form')).toBeNull());
  expect(calls.find((c) => c.key === 'PATCH /api/career/applications/1/milestones/8')!.body).toEqual({ kind: 'interview', on_date: '2099-01-06', note: '' });

  vi.stubGlobal('confirm', vi.fn(() => false));
  (el.querySelector('[aria-label^="Delete Applied"]') as HTMLButtonElement).click();
  expect(calls.some((c) => c.key.startsWith('DELETE'))).toBe(false);
  vi.stubGlobal('confirm', vi.fn(() => true));
  (el.querySelector('[aria-label^="Delete Applied"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(el.querySelectorAll('.timeline > li')).toHaveLength(1));

  const follow = el.querySelector('.follow-up')!;
  set(follow.querySelector('input')!, '2026-11-03');
  submit(follow);
  await vi.waitFor(() => expect(calls.some((c) => c.key === 'PATCH /api/career/applications/1')).toBe(true));
  expect(calls.find((c) => c.key === 'PATCH /api/career/applications/1')!.body).toEqual({ follow_up_on: '2026-11-03' });
});

test('the list shows tracking columns, and an application sent elsewhere can be added', async () => {
  const row: ApplicationListItem = {
    ...app(), company: EVIL, follow_up_on: '2026-11-03', last_milestone: 'interview', last_milestone_on: '2026-10-20', next_interview: '2099-01-05',
  };
  const calls = api({
    'GET /api/career/applications': () => [row],
    'POST /api/career/applications/manual': () => ({ ...row, id: 2 }),
  });
  const { el, router } = await mount(ApplicationsView);
  await vi.waitFor(() => expect(el.querySelector('tbody tr')).not.toBeNull());
  const cells = [...el.querySelectorAll('tbody td')].map((td) => td.textContent?.trim());
  expect(cells[1]).toBe(EVIL);
  expect(cells[3]).toMatch(/^Interview, /);
  expect(el.querySelector('tbody td:nth-child(5) time')?.getAttribute('datetime')).toBe('2099-01-05');
  expect(el.querySelector('tbody td:nth-child(6) time')?.getAttribute('datetime')).toBe('2026-11-03');
  expect(el.querySelector('img')).toBeNull();

  const form = el.querySelector('.manual form')!;
  const [company, role, applied] = [...form.querySelectorAll('input')];
  set(company!, 'Initech');
  set(role!, 'Developer');
  set(applied!, '2026-10-02');
  submit(form);
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/applications/2'));
  expect(calls.find((c) => c.key.startsWith('POST'))!.body).toEqual({ company: 'Initech', role_title: 'Developer', applied_on: '2026-10-02' });
});
