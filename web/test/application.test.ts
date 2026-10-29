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
  sources: { 'sum-1': 'Master summary.', [N]: 'Acme GmbH | Senior Engineer | 2021-03 – 2024-06', [`${N}-1`]: 'Cut the build from 12 to 4 minutes.', 'skill-x': 'Python' },
  files: [],
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
        draft: { summary: evilLine, entries: [{ entry_id: EVIL, bullets: [evilLine] }], skill_ids: [EVIL], letter: { paragraphs: [evilLine] }, versions: 1 },
        sources: { [EVIL]: EVIL },
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
