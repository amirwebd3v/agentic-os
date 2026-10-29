<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import {
  ApiError, getMaster, saveMaster,
  type MasterBulletSection, type MasterEntry, type MasterEntrySection, type MasterSection, type MasterState,
} from '../api';
import MasterImport from '../components/MasterImport.vue';

// Every text here is the owner's CV: bound with v-model and rendered with {{ }} only.
const ORDER = ['Summary', 'Experience', 'Education', 'Projects', 'Certifications', 'Skills', 'Languages'] as const;
type Name = (typeof ORDER)[number];
const ENTRY_SECTIONS: readonly Name[] = ['Experience', 'Education', 'Projects', 'Certifications'];
const ADD_TEXT: Record<Name, string> = {
  Summary: 'Add a summary line', Experience: 'Add a job', Education: 'Add a school or degree', Projects: 'Add a project',
  Certifications: 'Add a certification', Skills: 'Add a skill', Languages: 'Add a language',
};
const PLACEHOLDER: Partial<Record<Name, string>> = { Skills: 'e.g. TypeScript', Languages: 'e.g. German (C1)' };
const DATE = /^\d{4}(-(0[1-9]|1[0-2]))?$/;

const state = ref<MasterState | null>(null);
const sections = ref<MasterSection[]>([]);
const saved = ref('[]');
const loadError = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);
const starting = ref(false);

const isEntries = (s: MasterSection): s is MasterEntrySection => 'entries' in s;
const dirty = computed(() => JSON.stringify(sections.value) !== saved.value);
const editing = computed(() => (state.value?.exists && 'sections' in state.value) || starting.value);
const missing = computed(() => ORDER.filter((n) => !sections.value.some((s) => s.name === n)));
const sorted = computed(() => [...sections.value].sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name)));

// Stable keys for items that have no id yet, without sending anything extra to the server.
const keys = new WeakMap<object, number>();
let next = 0;
const key = (o: object) => keys.get(o) ?? (keys.set(o, ++next), next);

function show(m: MasterState) {
  state.value = m;
  sections.value = m.exists && 'sections' in m ? structuredClone(m.sections) : [];
  saved.value = JSON.stringify(sections.value);
}
async function load() {
  loadError.value = null;
  try {
    show(await getMaster());
  } catch {
    loadError.value = "Couldn't load your master CV. Is the server running?";
  }
}
function startFresh() {
  starting.value = true;
  sections.value = [
    { name: 'Summary', bullets: [{ text: '' }] },
    { name: 'Experience', entries: [blankEntry()] },
    { name: 'Skills', bullets: [{ text: '' }] },
    { name: 'Languages', bullets: [{ text: '' }] },
  ];
}
const blankEntry = (): MasterEntry => ({ org: '', title: '', start: '', end: 'present', location: '', bullets: [{ text: '' }] });
function addSection(name: Name) {
  sections.value.push(ENTRY_SECTIONS.includes(name) ? { name, entries: [blankEntry()] } as MasterEntrySection : { name, bullets: [{ text: '' }] } as MasterBulletSection);
}
function moveIn<T>(list: T[], i: number, by: number) {
  const j = i + by;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
}
const drop = <T>(list: T[], i: number) => list.splice(i, 1);
/** Adds an empty item and puts the cursor in it (the last field of `box`). */
async function add<T>(list: T[], item: T, box: string) {
  list.push(item);
  await nextTick();
  [...document.querySelectorAll<HTMLElement>(`${box} :is(textarea, input)`)].at(-1)?.focus();
}
const removeSection = (s: MasterSection) => {
  if (window.confirm(`Remove the whole ${s.name} section?`)) sections.value = sections.value.filter((x) => x !== s);
};

/** The draft as it will be saved: empty lines dropped, empty sections left out, text trimmed. */
function cleaned(): MasterSection[] {
  return sections.value
    .map((s): MasterSection => {
      const bullets = (b: { id?: string; text: string }[]) => b.map((x) => ({ ...x, text: x.text.trim() })).filter((x) => x.text);
      if (!isEntries(s)) return { ...s, bullets: bullets(s.bullets) };
      const entries = s.entries
        .map((e) => ({ ...e, org: e.org.trim(), title: e.title.trim(), start: e.start.trim(), end: e.end.trim(), location: e.location.trim(), bullets: bullets(e.bullets) }))
        .filter((e) => e.org || e.title || e.bullets.length);
      return { ...s, entries };
    })
    .filter((s) => (isEntries(s) ? s.entries.length : s.bullets.length));
}
const badDate = (e: MasterEntry) => !DATE.test(e.start.trim());
const badEnd = (e: MasterEntry) => e.end.trim() !== 'present' && !DATE.test(e.end.trim());
const problems = computed(() =>
  sections.value.flatMap((s) =>
    isEntries(s)
      ? s.entries.flatMap((e) =>
          (e.org || e.title) && (badDate(e) || badEnd(e) || !e.org.trim()) ? [`${s.name}: ${e.org || e.title || 'an entry'}`] : [],
        )
      : [],
  ),
);

const ERRORS: Record<string, string> = {
  master_changed: 'career/master.md changed in Obsidian since you opened this page. Load the new version, then make your change again.',
  bad_master: 'Something is not in the expected form. Dates are a year or year-month (2021 or 2021-03), the end can be “present”, and no field may hold a line break or “|”.',
};
async function save() {
  if (problems.value.length) return void (error.value = `Fix the dates or names first: ${problems.value.join('; ')}.`);
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    const hash = state.value?.exists ? state.value.hash : null;
    show(await saveMaster(hash, cleaned()));
    starting.value = false;
    notice.value = 'Saved to career/master.md.';
  } catch (err) {
    const code = err instanceof ApiError ? err.detail : undefined;
    error.value = (code && ERRORS[code]) || "Couldn't save. Is the server running?";
  } finally {
    busy.value = false;
  }
}
function discard() {
  sections.value = JSON.parse(saved.value) as MasterSection[];
  starting.value = false;
  error.value = null;
}

const jump = (name: string) => document.getElementById(`cv-${name}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
const onKey = (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && dirty.value) {
    e.preventDefault();
    void save();
  }
};
const beforeUnload = (e: BeforeUnloadEvent) => dirty.value && e.preventDefault();
onBeforeRouteLeave(() => !dirty.value || window.confirm('Leave without saving your changes to the master CV?'));
onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', beforeUnload);
  void load();
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('beforeunload', beforeUnload);
});
</script>

<template>
  <main class="page master">
    <header class="page-head">
      <h1>Master CV</h1>
      <p class="lede">Everything the app may say about you. Each drafted line cites a line here, so keep it true and complete; tailoring picks from it.</p>
    </header>
    <p v-if="loadError" class="notice danger" role="alert">{{ loadError }} <button type="button" @click="load">Try again</button></p>
    <p v-else-if="!state" class="placeholder" role="status">Loading…</p>

    <template v-else-if="!editing && !state.exists">
      <div class="composer">
        <section class="notice">
          <h2>Import the CV you have</h2>
          <p>Put your CV (Word, PDF, Markdown or text) or your LinkedIn data export in <code>career/import/</code> inside your data folder, then import. You approve the result in Review before anything is written.</p>
          <MasterImport />
        </section>
        <section class="notice">
          <h2>Or write it here</h2>
          <p>Start from an empty master CV with a summary, your jobs, skills and languages. It is saved as <code>career/master.md</code> in your vault, so you can also edit it in Obsidian.</p>
          <button type="button" class="primary" @click="startFresh">Start writing</button>
        </section>
      </div>
    </template>

    <div v-else-if="state.exists && 'error' in state && !starting" class="notice danger" role="alert">
      <p><strong>career/master.md can't be read.</strong> {{ state.error }}</p>
      <p>Fix that line in Obsidian, then load it again.</p>
      <button type="button" @click="load">Load again</button>
    </div>

    <div v-else class="cv">
      <div>
        <p v-if="error" class="notice danger" role="alert">
          {{ error }} <button v-if="error.includes('Obsidian')" type="button" @click="load">Load the new version</button>
        </p>
        <p v-else-if="notice && !dirty" class="notice ok" role="status">{{ notice }}</p>

        <section v-for="s in sorted" :id="`cv-${s.name}`" :key="s.name" class="cv-section" :aria-label="s.name">
          <header>
            <h2>{{ s.name }}</h2>
            <button type="button" class="quiet danger" :aria-label="`Remove the ${s.name} section`" @click="removeSection(s)">Remove section</button>
          </header>

          <template v-if="isEntries(s)">
            <article v-for="(e, i) in s.entries" :key="key(e)" class="cv-entry" :aria-label="e.org || `New ${s.name} entry`">
              <div class="cv-entry-head">
                <label>{{ s.name === 'Education' ? 'School' : s.name === 'Certifications' ? 'Issuer' : 'Employer' }}
                  <input v-model="e.org" class="org" type="text" maxlength="120" :aria-invalid="!!(e.title || e.bullets.length > 1) && !e.org.trim()" />
                </label>
                <label>{{ s.name === 'Education' ? 'Degree' : 'Title' }} <input v-model="e.title" type="text" maxlength="120" /></label>
                <label>From <input v-model="e.start" type="text" maxlength="7" placeholder="2021-03" :aria-invalid="!!e.start && badDate(e)" /></label>
                <label>To <input v-model="e.end" type="text" maxlength="7" placeholder="present" :aria-invalid="!!e.end && badEnd(e)" /></label>
                <label>Where <input v-model="e.location" type="text" maxlength="120" /></label>
                <span class="cv-tools">
                  <button type="button" class="quiet" :aria-label="`Move ${e.org || 'entry'} up`" :disabled="i === 0" @click="moveIn(s.entries, i, -1)">Up</button>
                  <button type="button" class="quiet" :aria-label="`Move ${e.org || 'entry'} down`" :disabled="i === s.entries.length - 1" @click="moveIn(s.entries, i, 1)">Down</button>
                  <button type="button" class="quiet danger" :aria-label="`Remove ${e.org || 'entry'}`" @click="drop(s.entries, i)">Remove</button>
                </span>
              </div>
              <ul class="lines cv-items">
                <li v-for="(b, j) in e.bullets" :key="key(b)" class="cv-item">
                  <textarea v-model="b.text" rows="1" maxlength="500" :aria-label="`${e.org || 'Entry'}, line ${j + 1}`" placeholder="What you did and what came of it"></textarea>
                  <span class="cv-tools">
                    <button type="button" class="quiet" :aria-label="`Move ${e.org || 'entry'} line ${j + 1} up`" :disabled="j === 0" @click="moveIn(e.bullets, j, -1)">Up</button>
                    <button type="button" class="quiet" :aria-label="`Move ${e.org || 'entry'} line ${j + 1} down`" :disabled="j === e.bullets.length - 1" @click="moveIn(e.bullets, j, 1)">Down</button>
                    <button type="button" class="quiet danger" :aria-label="`Remove ${e.org || 'entry'} line ${j + 1}`" @click="drop(e.bullets, j)">Remove</button>
                  </span>
                </li>
              </ul>
              <button type="button" class="quiet" @click="add(e.bullets, { text: '' }, `#cv-${s.name} .cv-entry:nth-of-type(${i + 1}) .cv-items`)">Add line</button>
            </article>
            <p class="add-row"><button type="button" @click="add(s.entries, blankEntry(), `#cv-${s.name} .cv-entry:last-of-type .cv-entry-head label:first-child`)">{{ ADD_TEXT[s.name] }}</button></p>
          </template>

          <template v-else>
            <ul class="lines">
              <li v-for="(b, j) in s.bullets" :key="key(b)" class="cv-item">
                <textarea v-model="b.text" rows="1" maxlength="500" :aria-label="`${s.name}, line ${j + 1}`" :placeholder="PLACEHOLDER[s.name]"></textarea>
                <span class="cv-tools">
                  <button type="button" class="quiet" :aria-label="`Move ${s.name} line ${j + 1} up`" :disabled="j === 0" @click="moveIn(s.bullets, j, -1)">Up</button>
                  <button type="button" class="quiet" :aria-label="`Move ${s.name} line ${j + 1} down`" :disabled="j === s.bullets.length - 1" @click="moveIn(s.bullets, j, 1)">Down</button>
                  <button type="button" class="quiet danger" :aria-label="`Remove ${s.name} line ${j + 1}`" @click="drop(s.bullets, j)">Remove</button>
                </span>
              </li>
            </ul>
            <p class="add-row"><button type="button" class="quiet" @click="add(s.bullets, { text: '' }, `#cv-${s.name} .lines`)">{{ ADD_TEXT[s.name] }}</button></p>
          </template>
        </section>

        <div v-if="dirty" class="savebar" role="region" aria-label="Unsaved changes">
          <span>Unsaved changes</span>
          <span class="row">
            <button type="button" :disabled="busy" @click="discard">Discard</button>
            <button type="button" class="primary" :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'Save' }} <kbd>Ctrl S</kbd></button>
          </span>
        </div>
      </div>

      <aside aria-label="Sections">
        <nav class="hint" aria-label="Jump to a section">
          <p class="label">Sections</p>
          <p v-for="s in sorted" :key="s.name">
            <a :href="`#cv-${s.name}`" @click.prevent="jump(s.name)">{{ s.name }}</a>
            · {{ isEntries(s) ? `${s.entries.length} ${s.entries.length === 1 ? 'entry' : 'entries'}` : `${s.bullets.length} ${s.bullets.length === 1 ? 'line' : 'lines'}` }}
          </p>
        </nav>
        <div v-if="missing.length" class="row">
          <button v-for="n in missing" :key="n" type="button" class="quiet" @click="addSection(n)">Add {{ n }}</button>
        </div>
        <p class="hint">Saved as <code>career/master.md</code> in your vault. If you edit it in Obsidian too, the app notices and won't overwrite your change. Applications you already drafted keep their lines.</p>
      </aside>
    </div>
  </main>
</template>
