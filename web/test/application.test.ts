import { createPinia, setActivePinia } from 'pinia';
import { createApp } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { ApplicationDetail, ApplicationStatus, Draft } from '../src/api';
import { wordDiff } from '../src/diff';
import { POLL_MS, statusLabel, useCareerStore } from '../src/stores/career';
import ApplicationView from '../src/views/ApplicationView.vue';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const EVIL = '<img src=x onerror="alert(1)">';
const draft = (): Draft => ({
  v: 2,
  cv: {
    sections: [
      { name: 'Summary', bullets: [{ id: 'l-1', text: 'Summary line.', cites: ['sum-1'], origin: 'model' }] },
      {
        name: 'Experience',
        entries: [{
          id: 'e-1', source: 'exp-acme-2021', org: 'Acme GmbH', title: 'Senior Engineer', start: '2021-03', end: 'present', location: 'Berlin',
          bullets: [
            { id: 'l-2', text: 'Cut build time to 4 minutes.', cites: ['exp-acme-2021-1'], origin: 'model' },
            { id: 'l-3', text: 'Led a team of 4.', cites: ['exp-acme-2021-2'], origin: 'model' },
          ],
        }],
      },
      { name: 'Skills', bullets: [{ id: 'l-4', text: 'Python', cites: ['skill-python'], origin: 'model' }] },
    ],
  },
  letter: { paragraphs: [{ id: 'l-5', text: 'Para one.', cites: ['sum-1'], origin: 'model' }] },
  versions: 1,
});
const app = (over: Partial<ApplicationDetail> = {}): ApplicationDetail => ({
  id: 1, company: 'Acme', role_title: 'Engineer', language: 'en', status: 'draft_ready', step: 'verify', fail_code: null,
  follow_up_on: null, created_at: '2026-10-28T00:00:00Z', updated_at: '2026-10-28T00:00:00Z', archived_at: null,
  requirements: null, coverage: { matched: 1, total: 2 }, draft: draft(),
  edited_refs: [], verify: { ok: true, violations: [] },
  sources: { 'sum-1': 'Master summary.', 'exp-acme-2021-1': 'Cut the build from 12 to 4 minutes.', 'skill-python': 'Python' },
  languages: [], files: [], milestones: [],
  ...over,
});

/** Routes fetch by method + path; each handler returns the JSON body (status 200) or a Response. */
function api(routes: Record<string, (body: unknown) => unknown>) {
  const calls: { key: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    const key = `${init.method} ${path}`;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ key, body });
    const handler = routes[key];
    if (!handler) return Response.json({ error: 'not_found' }, { status: 404 });
    const out = handler(body);
    return out instanceof Response ? out : Response.json(out);
  }));
  return calls;
}
async function mount() {
  setActivePinia(createPinia());
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  const el = document.createElement('div');
  document.body.append(el);
  createApp(ApplicationView, { id: '1' }).use(router).mount(el);
  await vi.waitFor(() => expect(el.querySelector('h1')).not.toBeNull());
  return el;
}
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text))!;
const byLabel = (el: HTMLElement, label: string) => el.querySelector(`[aria-label="${label}"]`) as HTMLElement;
const type = (el: Element, value: string) => {
  (el as HTMLTextAreaElement).value = value;
  el.dispatchEvent(new Event('input'));
};

test('model and file text in a draft renders as text, never as HTML', async () => {
  const d = draft();
  d.cv.sections[0] = { name: 'Summary', bullets: [{ id: 'l-1', text: EVIL, cites: [EVIL], origin: 'model' }] };
  d.letter.paragraphs = [{ id: 'l-5', text: EVIL, cites: [], origin: 'owner' }];
  api({
    'GET /api/career/applications/1': () =>
      app({
        status: 'final', step: null, company: EVIL, role_title: EVIL, draft: d, sources: { [EVIL]: EVIL },
        requirements: { language: 'en', company: EVIL, role_title: EVIL, seniority: 'mid', location_mode: 'remote', must_have: [{ id: 'm', text: EVIL, kind: 'skill' }], nice_to_have: [], injection_suspected: true },
        verify: { ok: false, violations: [{ code: 'unsupported_entity', ref: 'l-1', token: EVIL }, { code: EVIL, ref: 'letter' }] },
      }),
  });
  const el = await mount();
  expect(el.querySelector('img')).toBeNull();
  expect(el.querySelector('[onerror]')).toBeNull();
  expect(el.textContent).toContain(EVIL);
  (el.querySelector('.cv-item .line-text') as HTMLElement).click(); // final: read-only lines, the source follows the click
  await vi.waitFor(() => expect(el.querySelector('.source-panel blockquote')?.textContent).toBe(EVIL));
});

test('the draft is edited like the master CV and saved as one document; the server decides cites and origin', async () => {
  const calls = api({
    'GET /api/career/applications/1': () => app(),
    'PUT /api/career/applications/1/draft': () => app({ edited_refs: ['l-2', 'l-6'], draft: { ...draft(), versions: 2 } }),
  });
  const el = await mount();
  expect(el.querySelector('.savebar')).toBeNull();
  type(byLabel(el, 'Acme GmbH, line 1'), '  Cut the build time to 4 minutes.  ');
  byLabel(el, 'Move Acme GmbH line 2 up').click();
  button(el, 'Add line').click();
  await vi.waitFor(() => expect(el.querySelectorAll('#draft-Experience textarea')).toHaveLength(3));
  type([...el.querySelectorAll('#draft-Experience textarea')].at(-1)!, 'Mentored two juniors.');
  byLabel(el, 'Remove Skills line 1').click();
  await vi.waitFor(() => expect(el.querySelector('.savebar')).not.toBeNull());
  button(el, 'Save').click();
  await vi.waitFor(() => expect(calls.some((c) => c.key.startsWith('PUT'))).toBe(true));
  const body = calls.find((c) => c.key.startsWith('PUT'))!.body as Draft;
  expect(body.versions).toBe(1);
  const exp = body.cv.sections.find((s) => s.name === 'Experience') as Extract<Draft['cv']['sections'][number], { entries: unknown }>;
  expect(exp.entries[0]!.bullets.map((b) => [b.id, b.text])).toEqual([
    ['l-3', 'Led a team of 4.'], ['l-2', 'Cut the build time to 4 minutes.'], [undefined, 'Mentored two juniors.'],
  ]);
  expect(body.cv.sections.some((s) => s.name === 'Skills')).toBe(false); // its only line removed: the section goes
  expect(body.letter.paragraphs).toHaveLength(1);
  await vi.waitFor(() => expect(el.querySelector('.savebar')).toBeNull());
  expect(el.textContent).toContain('Version 2');
});

test('a stale save says so instead of overwriting', async () => {
  api({
    'GET /api/career/applications/1': () => app(),
    'PUT /api/career/applications/1/draft': () => Response.json({ error: 'draft_changed' }, { status: 409 }),
  });
  const el = await mount();
  type(byLabel(el, 'Summary, line 1'), 'A new summary.');
  await vi.waitFor(() => expect(el.querySelector('.savebar')).not.toBeNull());
  button(el, 'Save').click();
  await vi.waitFor(() => expect(el.querySelector('[role="alert"]')?.textContent).toContain('changed since you opened it'));
});

test('a flagged draft finalises only after the acknowledgement, then polls while it renders', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const states = [app({ status: 'final', step: 'render' }), app({ status: 'final', step: null, files: [{ kind: 'cv_docx', bytes: 2048 }] })];
  const calls = api({
    'GET /api/career/applications/1': () => states.shift() ?? app({ status: 'final', step: null }),
    'POST /api/career/applications/1/final': () => app({ status: 'final', step: 'render' }),
  });
  states.unshift(app({ status: 'flagged', verify: { ok: false, violations: [{ code: 'too_long', ref: 'l-5' }] } }));
  const el = await mount();
  expect(el.textContent).toContain('marks 1 line');
  const finalise = button(el, 'Finalise and create files');
  expect(finalise.disabled).toBe(true);
  (el.querySelector('.ack input') as HTMLInputElement).click();
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
  expect(el.querySelector('.reading textarea')).toBeNull(); // no edits after finalising
});

test('a failed render offers a retry', async () => {
  const calls = api({
    'GET /api/career/applications/1': () => app({ status: 'final', step: null, fail_code: 'render_failed' }),
    'POST /api/career/applications/1/render': () => app({ status: 'final', step: 'render' }),
  });
  const el = await mount();
  expect(el.textContent).toContain('Files failed');
  button(el, 'Create the files again').click();
  await vi.waitFor(() => expect(el.textContent).toContain('Creating files'));
  expect(calls.some((c) => c.key === 'POST /api/career/applications/1/render')).toBe(true);
  useCareerStore().stop();
});

test('every state has a status in words', () => {
  const s = (status: ApplicationStatus, step: ApplicationDetail['step'] = null, fail_code: ApplicationDetail['fail_code'] = null) =>
    statusLabel(app({ status, step, fail_code })).text;
  expect([
    s('processing', 'intake'), s('processing', 'letter'), s('draft_ready'), s('flagged'), s('needs_answers'), s('failed', 'match', 'no_match'),
    s('final', 'render'), s('final'), s('final', null, 'render_failed'), s('applied'), s('withdrawn'),
  ]).toEqual([
    'Reading the posting', 'Writing the cover letter', 'Ready for review', 'Needs your check', 'Waiting for your answers', 'Failed',
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

test('rename, retry and delete', async () => {
  const confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
  const calls = api({
    'GET /api/career/applications/1': () => app({ status: 'failed', fail_code: 'provider_error', draft: null }),
    'PATCH /api/career/applications/1': () => app({ status: 'failed', fail_code: 'provider_error', draft: null, role_title: 'Staff Engineer' }),
    'POST /api/career/applications/1/retry': () => app({ status: 'processing', step: 'intake', draft: null }),
    'DELETE /api/career/applications/1': () => new Response(null, { status: 204 }),
  });
  const el = await mount();
  button(el, 'Rename').click();
  await vi.waitFor(() => expect(el.querySelector('.title-edit')).not.toBeNull());
  type(el.querySelector('.title-edit input')!, ' Staff Engineer ');
  el.querySelector('.title-edit')!.dispatchEvent(new Event('submit'));
  await vi.waitFor(() => expect(el.querySelector('h1')!.textContent).toContain('Staff Engineer'));
  expect(calls.at(-1)).toEqual({ key: 'PATCH /api/career/applications/1', body: { role_title: 'Staff Engineer' } }); // company unchanged: not sent
  button(el, 'Delete').click();
  await vi.waitFor(() => expect(calls.some((c) => c.key === 'DELETE /api/career/applications/1')).toBe(true));
  await vi.waitFor(() => expect(button(el, 'Retry with the same posting').disabled).toBe(false));
  button(el, 'Retry with the same posting').click();
  await vi.waitFor(() => expect(el.textContent).toContain('Working on it'));
  expect(button(el, 'Delete').disabled).toBe(true); // not while a step runs
  useCareerStore().stop();
});

test('a suggestion enters the CV only after "true for me", and is saved with its suggestion id', async () => {
  const gaps = {
    missing_keywords: [{ keyword: 'Kubernetes', importance: 'must' as const, in_master: false }], weak_sections: [], formatting: [],
    suggestions: [{ id: 's-1', section: 'Experience', entry_id: 'exp-acme-2021', text: `Ran services on Kubernetes ${EVIL}`, why: 'The posting asks for it.', keyword: 'Kubernetes' }],
    dismissed: [],
  };
  const ats = { score: 72, parts: [{ name: 'Keywords', score: 20, max: 30, notes: [] }], findings: [{ severity: 'high' as const, text: 'No Kubernetes.' }], draft_version: 1, created_at: '2026-10-29T10:00:00Z', history: [] };
  const calls = api({
    'GET /api/career/applications/1': () => app({ gaps, ats }),
    'PUT /api/career/applications/1/draft': () => app({ gaps, ats, draft: { ...draft(), versions: 2 } }),
    'POST /api/career/applications/1/ats': () => app({ gaps, ats: { ...ats, score: 84, findings: [], draft_version: 2 }, draft: { ...draft(), versions: 2 } }),
  });
  const el = await mount();
  button(el, 'Fit and ATS').click();
  await vi.waitFor(() => expect(el.querySelector('.score')?.textContent).toContain('72'));
  expect(el.textContent).toContain('Not there yet');
  expect(el.querySelector('img')).toBeNull();
  button(el, 'Use this').click();
  await vi.waitFor(() => expect(el.querySelector('.accept')).not.toBeNull());
  const add = button(el, 'Add to the CV');
  expect(add.disabled).toBe(true); // not until you say it is true
  (el.querySelector<HTMLInputElement>('.accept .check input')!).click();
  (el.querySelectorAll<HTMLInputElement>('.accept .check input')[1]!).click(); // not into the master this time
  await vi.waitFor(() => expect(add.disabled).toBe(false));
  add.click();
  await vi.waitFor(() => expect(el.querySelector('.savebar')).not.toBeNull());
  button(el, 'Save').click();
  await vi.waitFor(() => expect(calls.some((c) => c.key.startsWith('PUT'))).toBe(true));
  const body = calls.find((c) => c.key.startsWith('PUT'))!.body as Draft;
  const exp = body.cv.sections.find((s) => s.name === 'Experience') as Extract<Draft['cv']['sections'][number], { entries: unknown }>;
  expect(exp.entries[0]!.bullets.at(-1)).toEqual({ text: `Ran services on Kubernetes ${EVIL}`, origin: 'suggestion', suggestion_id: 's-1' });
  expect(calls.some((c) => c.key.includes('/master'))).toBe(false);
  await vi.waitFor(() => expect(el.querySelector('.savebar')).toBeNull());
  button(el, 'Fit and ATS').click();
  await vi.waitFor(() => expect(button(el, 'Re-check ATS').disabled).toBe(false));
  button(el, 'Re-check ATS').click();
  await vi.waitFor(() => expect(el.textContent).toContain('Ready to download'));
});

test('waiting for answers: the questions are asked on the page and a skip is sent as null', async () => {
  const questions = { evidence: [], questions: [{ id: 'q-1', text: `Have you led hiring? ${EVIL}`, why: 'The role builds a team.' }, { id: 'q-2', text: 'Any on-call?', why: 'Ops role.' }] };
  const calls = api({
    'GET /api/career/applications/1': () => app({ status: 'needs_answers', step: 'questions', questions }),
    'POST /api/career/applications/1/answers': () => app({ status: 'processing', step: 'letter', questions }),
  });
  const el = await mount();
  expect(el.textContent).toContain('Waiting for your answers');
  button(el, 'Answer the questions').click();
  await vi.waitFor(() => expect(el.querySelector('#ans-q-1')).not.toBeNull());
  expect(el.querySelector('img')).toBeNull();
  type(el.querySelector('#ans-q-1')!, '  Yes, four engineers in 2023.  ');
  button(el, 'Write the letter').click();
  await vi.waitFor(() => expect(calls.some((c) => c.key.startsWith('POST'))).toBe(true));
  expect(calls.find((c) => c.key.startsWith('POST'))!.body).toEqual({ answers: [{ id: 'q-1', text: 'Yes, four engineers in 2023.' }, { id: 'q-2', text: null }] });
  await vi.waitFor(() => expect(el.textContent).toContain('Writing the cover letter'));
  useCareerStore().stop();
});

const tabTo = async (el: HTMLElement, name: string) => {
  ([...el.querySelectorAll('.tabs button')].find((b) => b.textContent === name) as HTMLButtonElement).click();
  await vi.waitFor(() => expect(el.querySelector('.tab-actions button:last-child')?.textContent).toMatch(name === 'Cover letter' ? 'Refresh letter' : 'Re-read posting'));
};

test('#72: a stale CV shows the banner; Refresh CV is off with a reason while there are unsaved edits', async () => {
  const calls = api({
    'GET /api/career/applications/1': () => app({ stale: { cv: 'master', letter: 'cv' }, can_restore: true }),
    'POST /api/career/applications/1/refresh': () => app({ status: 'processing', step: 'match' }),
  });
  const el = await mount();
  expect(el.textContent).toContain('Out of date: your master CV changed');
  const refresh = button(el, 'Refresh CV') as HTMLButtonElement;
  expect(refresh.disabled).toBe(false);
  expect(button(el, 'Restore previous version')).toBeTruthy();
  type(byLabel(el, 'Acme GmbH, line 1'), 'Changed.');
  await vi.waitFor(() => expect(refresh.disabled).toBe(true));
  expect(el.querySelector('.tab-actions')!.textContent).toContain('Save or discard your changes first.');
  button(el, 'Discard').click();
  await vi.waitFor(() => expect(refresh.disabled).toBe(false));
  refresh.click();
  await vi.waitFor(() => expect(calls.find((c) => c.key === 'POST /api/career/applications/1/refresh')?.body).toEqual({ part: 'cv' }));
  await vi.waitFor(() => expect(el.textContent).toContain('Wait until the current step finishes.'));
  useCareerStore().stop();
});

test('#73: Refresh letter asks first; a declined confirm sends nothing', async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal('confirm', confirm);
  const calls = api({ 'GET /api/career/applications/1': () => app({ stale: { cv: null, letter: 'posting' } }) });
  const el = await mount();
  await tabTo(el, 'Cover letter');
  expect(el.textContent).toContain('Out of date: the posting changed');
  button(el, 'Refresh letter').click();
  expect(confirm).toHaveBeenCalledOnce();
  expect(calls.some((c) => c.key.includes('refresh'))).toBe(false);
});

test('#72: the posting is edited as text and saved with the company fields; old files get a notice', async () => {
  const calls = api({
    'GET /api/career/applications/1': () =>
      app({ posting: EVIL, context: { company_name: 'Acme', company_website: null, target_country: null, research: null }, files: [{ kind: 'cv_docx', bytes: 2048 }] }),
    'PUT /api/career/applications/1/posting': () => app({ status: 'processing', step: 'intake', posting: 'New posting.' }),
  });
  const el = await mount();
  expect(el.textContent).toContain('These files are from the old version.');
  await tabTo(el, 'The posting');
  expect(el.querySelector('img')).toBeNull();
  const box = el.querySelector('.posting-edit textarea') as HTMLTextAreaElement;
  expect(box.value).toBe(EVIL);
  type(box, 'New posting.');
  await vi.waitFor(() => expect((button(el, 'Save the posting') as HTMLButtonElement).disabled).toBe(false));
  button(el, 'Save the posting').click();
  await vi.waitFor(() => expect(calls.find((c) => c.key.startsWith('PUT'))?.body).toEqual({ posting: 'New posting.', company_name: 'Acme' }));
  useCareerStore().stop();
});
