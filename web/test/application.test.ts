import { createPinia, setActivePinia } from 'pinia';
import { createApp } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { ApplicationDetail, ApplicationStatus } from '../src/api';
import { wordDiff } from '../src/diff';
import { POLL_MS, statusLabel, useCareerStore } from '../src/stores/career';
import MasterImport from '../src/components/MasterImport.vue';
import ApplicationView from '../src/views/ApplicationView.vue';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const EVIL = '<img src=x onerror="alert(1)">';
const N = 'exp-acme-2021';
const app = (over: Partial<ApplicationDetail> = {}): ApplicationDetail => ({
  id: 1, company: 'Acme', role_title: 'Engineer', language: 'en', status: 'draft_ready', step: 'verify', fail_code: null,
  follow_up_on: null, created_at: '2026-10-28T00:00:00Z', updated_at: '2026-10-28T00:00:00Z',
  requirements: null, coverage: { matched: 1, total: 2 },
  draft: {
    summary: { text: 'Summary line.', cites: ['sum-1'] },
    entries: [{ entry_id: N, bullets: [{ text: 'Cut build time to 4 minutes.', cites: [`${N}-1`] }] }],
    skill_ids: ['skill-x'],
    letter: { paragraphs: [{ text: 'Para one.', cites: ['sum-1'] }] },
    versions: 1,
  },
  edited_refs: [], verify: { ok: true, violations: [] },
  sources: { 'sum-1': 'Master summary.', [N]: 'Acme GmbH | Senior Engineer | 2021-03 | 2024-06 | Berlin', [`${N}-1`]: 'Cut the build from 12 to 4 minutes.', 'skill-x': 'Python' },
  languages: ['English (C1)'], files: [], milestones: [],
  ...over,
});

/** Routes fetch by method + path; each handler returns the JSON body (status 200) or a Response. */
function api(routes: Record<string, (body: unknown) => unknown>) {
  const calls: { key: string; body: unknown }[] = [];
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    const key = `${init.method} ${path}`;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ key, body });
    const handler = routes[key];
    if (!handler) return Response.json({ error: 'not_found' }, { status: 404 });
    const out = handler(body);
    return out instanceof Response ? out : Response.json(out);
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

async function mount() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  const el = document.createElement('div');
  document.body.append(el);
  createApp(ApplicationView, { id: '1' }).use(pinia).use(router).mount(el);
  await vi.waitFor(() => expect(el.querySelector('h1')).not.toBeNull());
  return el;
}
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;

test('model and file text in a draft renders as text, never as HTML', async () => {
  const evilLine = { text: EVIL, cites: [EVIL] };
  api({
    'GET /api/career/applications/1': () =>
      app({
        status: 'flagged', company: EVIL, role_title: EVIL,
        requirements: { language: 'en', company: EVIL, role_title: EVIL, seniority: 'mid', location_mode: 'remote', must_have: [{ id: 'm', text: EVIL, kind: 'skill' }], nice_to_have: [], injection_suspected: true },
        draft: {
          summary: evilLine, entries: [{ entry_id: EVIL, bullets: [evilLine], header: { title: EVIL, location: EVIL } }], skill_ids: [EVIL],
          skills_text: EVIL, languages_text: EVIL, letter: { paragraphs: [evilLine] }, versions: 1,
        },
        sources: { [EVIL]: EVIL }, languages: [EVIL],
        verify: { ok: false, violations: [{ code: 'unsupported_entity', ref: 'cv.summary', token: EVIL }, { code: EVIL, ref: 'letter' }] },
      }),
  });
  const el = await mount();
  expect(el.querySelector('img')).toBeNull();
  expect(el.querySelector('[onerror]')).toBeNull();
  expect(el.textContent).toContain(EVIL);
  expect(el.querySelectorAll('blockquote').length).toBeGreaterThan(0); // the source panel shows the (evil) master text, as text
});

test('edit in place sends one line by ref and shows the new version', async () => {
  const calls = api({
    'GET /api/career/applications/1': () => app(),
    'PATCH /api/career/applications/1/draft': () => app({ edited_refs: [`cv.entries.${N}.0`], draft: { ...app().draft!, versions: 2 } }),
  });
  const el = await mount();
  (el.querySelector(`[aria-label="Edit bullet 1 under Acme GmbH"]`) as HTMLButtonElement).click();
  await vi.waitFor(() => expect(el.querySelector('textarea')).not.toBeNull());
  const box = el.querySelector('textarea')!;
  box.value = '  Cut the build time to 4 minutes.  ';
  box.dispatchEvent(new Event('input'));
  el.querySelector('form')!.dispatchEvent(new Event('submit'));
  await vi.waitFor(() => expect(el.textContent).toContain('Edited by you'));
  expect(calls.find((c) => c.key.startsWith('PATCH'))!.body).toEqual({ edits: [{ ref: `cv.entries.${N}.0`, text: 'Cut the build time to 4 minutes.' }] });
  expect(el.textContent).toContain('Version 2');
  expect(el.querySelector('textarea')).toBeNull();
});

test('a flagged draft finalises only after the acknowledgement, then polls while it renders', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const states = [app({ status: 'final', step: 'render' }), app({ status: 'final', step: null, files: [{ kind: 'cv_docx', bytes: 2048 }] })];
  const calls = api({
    'GET /api/career/applications/1': () => states.shift() ?? app({ status: 'final', step: null }),
    'POST /api/career/applications/1/final': () => app({ status: 'final', step: 'render' }),
  });
  states.unshift(app({ status: 'flagged', verify: { ok: false, violations: [{ code: 'too_long', ref: 'letter.0' }] } }));
  const el = await mount();
  expect(el.textContent).toContain('Needs your check');
  expect(el.textContent).toContain('marks 1 line');
  const finalise = button(el, 'Finalise and create files');
  expect(finalise.disabled).toBe(true);
  const ack = el.querySelector('.ack input') as HTMLInputElement;
  ack.click();
  await vi.waitFor(() => expect(finalise.disabled).toBe(false));
  finalise.click();
  await vi.waitFor(() => expect(el.textContent).toContain('Creating the Word files'));
  expect(calls.find((c) => c.key.startsWith('POST'))!.body).toEqual({ acknowledge_flagged: true });
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await vi.waitFor(() => expect(el.querySelector('.downloads a')?.getAttribute('href')).toBe('/api/career/applications/1/files/cv_docx'));
  const gets = calls.filter((c) => c.key.startsWith('GET')).length;
  await vi.advanceTimersByTimeAsync(POLL_MS * 3);
  expect(calls.filter((c) => c.key.startsWith('GET')).length).toBe(gets); // final, not rendering: polling stopped
  expect(el.querySelector('[aria-label^="Edit"]')).toBeNull(); // no edits after finalising
});

test('a failed render offers a retry', async () => {
  const calls = api({
    'GET /api/career/applications/1': () => app({ status: 'final', step: null, fail_code: 'render_failed' }),
    'POST /api/career/applications/1/render': () => app({ status: 'final', step: 'render' }),
  });
  const el = await mount();
  expect(el.textContent).toContain('Files failed');
  expect(el.textContent).not.toContain('export');
  button(el, 'Create the files again').click();
  await vi.waitFor(() => expect(el.textContent).toContain('Creating files'));
  expect(calls.some((c) => c.key === 'POST /api/career/applications/1/render')).toBe(true);
  useCareerStore().stop();
});

test('every state has a status in words', () => {
  const s = (status: ApplicationStatus, step: ApplicationDetail['step'] = null, fail_code: ApplicationDetail['fail_code'] = null) =>
    statusLabel(app({ status, step, fail_code })).text;
  expect([
    s('processing', 'intake'), s('processing', 'verify'), s('draft_ready'), s('flagged'), s('failed', 'match', 'no_match'),
    s('final', 'render'), s('final'), s('final', null, 'render_failed'), s('applied'), s('withdrawn'),
  ]).toEqual([
    'Reading the posting', 'Checking every line against your CV', 'Ready for review', 'Needs your check', 'Failed',
    'Creating files', 'Final', 'Files failed', 'Applied', 'Withdrawn',
  ]);
});

test('wordDiff merges runs and keeps spacing', () => {
  expect(wordDiff('Cut the build from 12 to 4 minutes.', 'Cut build time to 4 minutes.')).toEqual([
    { op: ' ', text: 'Cut ' },
    { op: '-', text: 'the ' },
    { op: ' ', text: 'build ' },
    { op: '+', text: 'time ' },
    { op: '-', text: 'from 12 ' },
    { op: ' ', text: 'to 4 minutes.' },
  ]);
});

test('the master import shows its outcome and file warnings as text', async () => {
  api({ 'POST /api/career/master/import': () => Response.json({ error: 'import_empty', warnings: [`${EVIL}: skipped: unsupported format`] }, { status: 400 }) });
  const el = document.createElement('div');
  createApp(MasterImport).mount(el);
  el.querySelector('button')!.click();
  await vi.waitFor(() => expect(el.querySelector('[role="alert"]')).not.toBeNull());
  expect(el.textContent).toContain('No usable file in career/import/');
  expect(el.textContent).toContain(`${EVIL}: skipped`);
  expect(el.querySelector('img')).toBeNull();
});

const press = (el: Element, key: string, init: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
const type = (el: Element, value: string) => {
  (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event('input'));
};
const byLabel = (el: HTMLElement, label: string) => el.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;

test('an entry header is edited in place: changed fields only, a blank field is a remove, Esc restores focus', async () => {
  const draft = app().draft!;
  const calls = api({
    'GET /api/career/applications/1': () => app(),
    'PATCH /api/career/applications/1/draft': () =>
      app({
        draft: { ...draft, entries: [{ ...draft.entries[0]!, header: { title: 'Staff Engineer', location: '' } }], versions: 2 },
        edited_refs: [`cv.entries.${N}.header.title`, `cv.entries.${N}.header.location`],
      }),
  });
  const el = await mount();
  expect(el.querySelector('.entry-head')!.textContent).toContain('2021-03 – 2024-06 · Berlin');
  byLabel(el, 'Edit the header of Acme GmbH').click();
  await vi.waitFor(() => expect(el.querySelectorAll('.entry-head input')).toHaveLength(5));
  expect(document.activeElement).toBe(el.querySelector('.entry-head input'));
  press(el.querySelector('.entry-head input')!, 'Escape');
  await vi.waitFor(() => expect(document.activeElement).toBe(byLabel(el, 'Edit the header of Acme GmbH')));
  expect(calls.some((c) => c.key.startsWith('PATCH'))).toBe(false);

  byLabel(el, 'Edit the header of Acme GmbH').click();
  await vi.waitFor(() => expect(el.querySelectorAll('.entry-head input')).toHaveLength(5));
  const [, title, , , location] = el.querySelectorAll('.entry-head input');
  type(title!, ' Staff Engineer ');
  type(location!, '');
  press(title!, 'Enter', { ctrlKey: true });
  await vi.waitFor(() => expect(el.querySelector('.entry-head input')).toBeNull());
  expect(calls.find((c) => c.key.startsWith('PATCH'))!.body).toEqual({
    edits: [{ ref: `cv.entries.${N}.header.title`, text: 'Staff Engineer' }, { op: 'remove', ref: `cv.entries.${N}.header.location` }],
  });
  const head = el.querySelector('.entry-head')!.textContent!;
  expect(head).toContain('Acme GmbH · Staff Engineer');
  expect(head).not.toContain('Berlin');
  expect(head).toContain('Edited by you, not re-checked');
});

test('the skills and languages lines are editable like any line', async () => {
  const calls = api({
    'GET /api/career/applications/1': () => app(),
    'PATCH /api/career/applications/1/draft': () => app({ draft: { ...app().draft!, languages_text: 'English (C2), German' }, edited_refs: ['cv.languages'] }),
  });
  const el = await mount();
  expect(el.querySelector('[aria-label="Skills"]')!.textContent).toContain('Python');
  byLabel(el, 'Edit the languages').click();
  await vi.waitFor(() => expect(el.querySelector('textarea')).not.toBeNull());
  expect(el.querySelector('textarea')!.value).toBe('English (C1)');
  type(el.querySelector('textarea')!, 'English (C2), German');
  press(el.querySelector('textarea')!, 'Enter', { ctrlKey: true });
  await vi.waitFor(() => expect(el.querySelector('textarea')).toBeNull());
  expect(calls.find((c) => c.key.startsWith('PATCH'))!.body).toEqual({ edits: [{ ref: 'cv.languages', text: 'English (C2), German' }] });
  const languages = el.querySelector('[aria-label="Languages"]')!.textContent!;
  expect(languages).toContain('English (C2), German');
  expect(languages).toContain('Edited by you, not re-checked');
  expect(byLabel(el, 'Edit the skills')).not.toBeNull();
});

test('remove asks first and sends a remove op; a removed line keeps the refs after it', async () => {
  const draft = app().draft!;
  const two = { ...draft, entries: [{ entry_id: N, bullets: [draft.entries[0]!.bullets[0]!, { text: 'Second bullet.', cites: [`${N}-1`] }] }] };
  const confirm = vi.fn(() => false);
  vi.stubGlobal('confirm', confirm);
  const calls = api({
    'GET /api/career/applications/1': () => app({ draft: two }),
    'PATCH /api/career/applications/1/draft': () =>
      app({ draft: { ...two, entries: [{ entry_id: N, bullets: [{ ...two.entries[0]!.bullets[0]!, removed: true }, two.entries[0]!.bullets[1]!] }] }, edited_refs: [`cv.entries.${N}.0`] }),
  });
  const el = await mount();
  byLabel(el, 'Remove bullet 1 under Acme GmbH').click();
  expect(confirm).toHaveBeenCalledOnce();
  expect(calls.some((c) => c.key.startsWith('PATCH'))).toBe(false);
  confirm.mockReturnValue(true);
  byLabel(el, 'Remove bullet 1 under Acme GmbH').click();
  await vi.waitFor(() => expect(el.textContent).not.toContain('Cut build time'));
  expect(calls.find((c) => c.key.startsWith('PATCH'))!.body).toEqual({ edits: [{ op: 'remove', ref: `cv.entries.${N}.0` }] });
  expect(byLabel(el, 'Edit bullet 2 under Acme GmbH')).not.toBeNull(); // still `.1`, not renumbered
  expect(document.activeElement).toBe(el.querySelector('.reading'));
  byLabel(el, 'Remove Acme GmbH from the CV').click();
  await vi.waitFor(() => expect(calls.filter((c) => c.key.startsWith('PATCH'))).toHaveLength(2));
  expect(calls.at(-1)!.body).toEqual({ edits: [{ op: 'remove', ref: `cv.entries.${N}` }] });
});

test('add a line under an entry and a letter paragraph', async () => {
  const calls = api({ 'GET /api/career/applications/1': () => app(), 'PATCH /api/career/applications/1/draft': () => app() });
  const el = await mount();
  byLabel(el, 'Add line under Acme GmbH').click();
  await vi.waitFor(() => expect(el.querySelector('textarea')).not.toBeNull());
  type(el.querySelector('textarea')!, `  ${EVIL}  `);
  press(el.querySelector('textarea')!, 'Enter', { ctrlKey: true });
  await vi.waitFor(() => expect(el.querySelector('textarea')).toBeNull());
  expect(calls.find((c) => c.key.startsWith('PATCH'))!.body).toEqual({ edits: [{ op: 'add', ref: `cv.entries.${N}`, text: EVIL }] });
  expect(document.activeElement).toBe(byLabel(el, 'Add line under Acme GmbH'));

  byLabel(el, 'Add line to the letter').click();
  await vi.waitFor(() => expect(el.querySelector('textarea')).not.toBeNull());
  type(el.querySelector('textarea')!, 'A closing paragraph.');
  el.querySelector('form')!.dispatchEvent(new Event('submit'));
  await vi.waitFor(() => expect(calls.filter((c) => c.key.startsWith('PATCH'))).toHaveLength(2));
  expect(calls.at(-1)!.body).toEqual({ edits: [{ op: 'add', ref: 'letter', text: 'A closing paragraph.' }] });
  expect(el.querySelector('img')).toBeNull();
});
