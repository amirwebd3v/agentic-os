import { createPinia, setActivePinia } from 'pinia';
import { createApp } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, expect, test, vi } from 'vitest';
import type { MasterSection } from '../src/api';
import MasterView from '../src/views/MasterView.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const EVIL = '<img src=x onerror="alert(1)">';
const SECTIONS: MasterSection[] = [
  { name: 'Skills', bullets: [{ id: 'skill-python', text: 'Python' }, { id: 'skill-evil', text: EVIL }] },
  { name: 'Experience', entries: [{ id: 'exp-acme-2021', org: 'Acme', title: 'Engineer', start: '2021-03', end: 'present', location: 'Berlin', bullets: [] }] },
];

async function mount(put: (body: { hash: string | null; sections: MasterSection[] }) => Response) {
  const calls: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === 'GET') return Response.json({ exists: true, hash: 'h1', sections: SECTIONS });
    const body = JSON.parse(init.body as string);
    calls.push(body);
    return put(body);
  }));
  setActivePinia(createPinia());
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  const el = document.createElement('div');
  document.body.append(el);
  createApp(MasterView).use(router).mount(el);
  await vi.waitFor(() => expect(el.querySelector('.cv-section')).not.toBeNull());
  return { el, calls };
}
const click = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text))!.click();

test('the master renders as editable text; a change shows the save bar and saves with the hash, new lines without ids', async () => {
  const { el, calls } = await mount(() => Response.json({ exists: true, hash: 'h2', sections: SECTIONS }));
  expect(el.querySelector('img')).toBeNull();
  expect([...el.querySelectorAll('textarea')].map((t) => t.value)).toContain(EVIL);
  expect(el.querySelector('.savebar')).toBeNull();

  click(el, 'Add a skill');
  await vi.waitFor(() => expect(el.querySelectorAll('#cv-Skills textarea')).toHaveLength(3));
  const box = [...el.querySelectorAll<HTMLTextAreaElement>('#cv-Skills textarea')].at(-1)!;
  expect(document.activeElement).toBe(box); // the cursor lands in the new line
  box.value = '  Go  ';
  box.dispatchEvent(new Event('input'));
  await vi.waitFor(() => expect(el.querySelector('.savebar')).not.toBeNull());
  click(el, 'Save');
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  const sent = calls[0] as { hash: string; sections: MasterSection[] };
  expect(sent.hash).toBe('h1');
  expect(sent.sections.find((s) => s.name === 'Skills')).toEqual({
    name: 'Skills', bullets: [{ id: 'skill-python', text: 'Python' }, { id: 'skill-evil', text: EVIL }, { text: 'Go' }],
  });
});

const NEW_SKILL = { text: 'Rust', new: true, from: 'LinkedIn export' };
const merge = (added: object, sections: object[] = SECTIONS) => Response.json({ hash: 'h1', sections, added: { entries: 0, bullets: 0, skills: 0, languages: 0, ...added }, warnings: ['Skills.csv: note'] });

test('LinkedIn export: new lines are tagged and saved without their marks; Discard puts the master back', async () => {
  const withNew = [{ name: 'Skills', bullets: [{ id: 'skill-python', text: 'Python' }, NEW_SKILL] }, SECTIONS[1]!];
  const { el, calls } = await mount((body) => ('sections' in body ? Response.json({ exists: true, hash: 'h2', sections: SECTIONS }) : merge({ skills: 1 }, withNew)));
  click(el, 'Import LinkedIn export');
  await vi.waitFor(() => expect(el.querySelector('.notice.ok')?.textContent).toContain('your LinkedIn export: 0 new entries, 0 new lines, 1 skills'));
  expect(el.querySelector('.notice.ok')?.textContent).toContain('Skills.csv: note');
  expect(el.textContent).toContain('New from LinkedIn export');
  expect(calls).toEqual([{}]);

  click(el, 'Discard');
  await vi.waitFor(() => expect(el.textContent).not.toContain('New from LinkedIn export'));
  expect(el.querySelector('.savebar')).toBeNull();
  expect(calls).toHaveLength(1); // nothing was written

  click(el, 'Import LinkedIn export');
  await vi.waitFor(() => expect(el.querySelector('.savebar')).not.toBeNull());
  click(el, 'Save');
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect((calls[2] as { hash: string; sections: MasterSection[] }).sections[0]).toEqual({ name: 'Skills', bullets: [{ id: 'skill-python', text: 'Python' }, { text: 'Rust' }] });
});

test('LinkedIn export: nothing new keeps unsaved edits; an error shows its warnings and leaves the editor alone', async () => {
  let answer = () => merge({});
  const { el } = await mount(() => answer());
  click(el, 'Add a skill');
  await vi.waitFor(() => expect(el.querySelector('.savebar')).not.toBeNull());
  click(el, 'Import LinkedIn export');
  await vi.waitFor(() => expect(el.querySelector('.notice.ok')?.textContent).toContain('Nothing new in your LinkedIn export'));
  expect(el.querySelectorAll('#cv-Skills textarea')).toHaveLength(3);
  expect(el.querySelector('.savebar')).not.toBeNull();

  answer = () => Response.json({ error: 'import_empty', warnings: ['export.zip: skipped'] }, { status: 400 });
  click(el, 'Import LinkedIn export');
  await vi.waitFor(() => expect(el.querySelector('[role="alert"]')?.textContent).toContain('No LinkedIn export found'));
  expect(el.querySelector('[role="alert"]')?.textContent).toContain('export.zip: skipped');
  expect(el.querySelectorAll('#cv-Skills textarea')).toHaveLength(3);
});

test('no master yet: no LinkedIn button, since the merge needs a master', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ exists: false })));
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
  const el = document.createElement('div');
  document.body.append(el);
  createApp(MasterView).use(router).mount(el);
  await vi.waitFor(() => expect(el.querySelector('.composer')).not.toBeNull());
  expect(el.textContent).not.toContain('Import LinkedIn export');
});

test('a stale hash says the file changed in Obsidian; a bad date is caught before saving', async () => {
  const { el, calls } = await mount(() => Response.json({ error: 'master_changed' }, { status: 409 }));
  const start = el.querySelector<HTMLInputElement>('#cv-Experience input[placeholder="2021-03"]')!;
  start.value = 'March 21';
  start.dispatchEvent(new Event('input'));
  await vi.waitFor(() => expect(start.getAttribute('aria-invalid')).toBe('true'));
  click(el, 'Save');
  await vi.waitFor(() => expect(el.querySelector('[role="alert"]')?.textContent).toContain('Fix the dates'));
  expect(calls).toHaveLength(0);

  start.value = '2021-04';
  start.dispatchEvent(new Event('input'));
  click(el, 'Save');
  await vi.waitFor(() => expect(el.querySelector('[role="alert"]')?.textContent).toContain('changed in Obsidian'));
  expect(calls).toHaveLength(1);
});
