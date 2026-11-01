<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { ApiError, getMaster, parseCvFiles, parseLinkedIn, saveMaster, type MasterMerge, type MasterSection, type MasterState } from '../api';
import CvEditor from '../components/CvEditor.vue';
import { allLines, cleaned, isEntries, problems, type CvSection } from '../cv';

// Every text here is the owner's CV: bound with v-model and rendered with {{ }} only.
const state = ref<MasterState | null>(null);
const sections = ref<CvSection[]>([]);
const saved = ref('[]');
const hash = ref<string | null>(null);
const loadError = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const warnings = ref<string[]>([]);
const busy = ref(false);
const reading = ref<'word' | 'linkedin' | null>(null);
const starting = ref(false);
const dragging = ref(false);
const picker = ref<HTMLInputElement>();

const dirty = computed(() => JSON.stringify(sections.value) !== saved.value);
const editing = computed(() => sections.value.length > 0 || starting.value);
const counts = computed(() => ({
  entries: sections.value.reduce((n, s) => n + (isEntries(s) ? s.entries.length : 0), 0),
  lines: allLines(sections.value).length,
  fresh: allLines(sections.value).filter((l) => l.new).length + sections.value.reduce((n, s) => n + (isEntries(s) ? s.entries.filter((e) => e.new).length : 0), 0),
}));

function show(m: MasterState) {
  state.value = m;
  hash.value = m.exists ? m.hash : null;
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
    { name: 'Experience', entries: [{ org: '', title: '', start: '', end: 'present', location: '', bullets: [{ text: '' }] }] },
    { name: 'Skills', bullets: [{ text: '' }] },
    { name: 'Languages', bullets: [{ text: '' }] },
  ];
}

// ---------- import Word CVs: merged into the editor, nothing saved until you press Save ----------
const MAX_FILES = 10;
const MAX_BYTES = 5 * 1024 * 1024;
const PARSE_ERRORS: Record<string, string> = {
  contact_missing: 'Fill in at least your name in career/contact.md in your vault first, so it is kept away from the model.',
  provider_not_configured: 'Connect a provider first (see the banner at the top).',
  provider_error: 'The model provider returned an error. Try again.',
  import_unreadable: 'Those files gave no text. Only Word files (.docx) can be read here.',
  bad_upload: 'Choose up to 10 Word files (.docx), each under 5 MB.',
  bad_master: 'Your current career/master.md can’t be read, so nothing can be merged into it. Fix it in Obsidian first.',
  import_empty: 'No LinkedIn export found. Request it under Settings → Get a copy of your data on LinkedIn, unzip it into career/import in the data folder (it needs Profile.csv or Positions.csv), then try again.',
  linkedin_unreadable: 'Those files don’t have the columns of a LinkedIn export, so nothing was read. Download the export again, in English if you can.',
  master_missing: 'There is no master CV to merge into yet. Import a Word CV or start writing first.',
};
const base64 = (f: File) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] ?? '');
    r.onerror = () => fail(r.error);
    r.readAsDataURL(f);
  });
async function runImport(kind: 'word' | 'linkedin', what: string, parse: () => Promise<MasterMerge>) {
  reading.value = kind;
  error.value = null;
  notice.value = null;
  warnings.value = [];
  try {
    const res = await parse();
    warnings.value = res.warnings;
    const a = res.added;
    // Nothing to review: the editor and anything typed in it stay as they are.
    if (!a.entries && !a.bullets && !a.skills && !a.languages) return void (notice.value = `Nothing new in ${what}: everything is already in your master CV.`);
    // The merge replaces the editor's content, so anything typed meanwhile is kept only if it was saved.
    hash.value = res.hash;
    sections.value = res.sections;
    starting.value = true;
    notice.value = `Read ${what}: ${a.entries} new entries, ${a.bullets} new lines, ${a.skills} skills and ${a.languages} languages, marked “New”. Check them, then Save.`;
  } catch (err) {
    const code = err instanceof ApiError ? err.detail : undefined;
    error.value = (code && PARSE_ERRORS[code]) || "Couldn't read the files. Is the server running?";
    warnings.value = err instanceof ApiError ? err.warnings : [];
  } finally {
    reading.value = null;
    if (picker.value) picker.value.value = '';
  }
}
async function importFiles(list: FileList | File[] | null) {
  const files = [...(list ?? [])];
  if (!files.length || reading.value || busy.value) return; // a drop isn't stopped by the disabled buttons
  const bad = files.filter((f) => !f.name.toLowerCase().endsWith('.docx') || f.size > MAX_BYTES);
  if (bad.length || files.length > MAX_FILES) {
    warnings.value = [];
    error.value = `Choose up to ${MAX_FILES} Word files (.docx), each under 5 MB.${bad.length ? ` Not accepted: ${bad.map((f) => f.name).join(', ')}.` : ''}`;
    return;
  }
  await runImport('word', `${files.length} ${files.length === 1 ? 'file' : 'files'}`, async () => parseCvFiles(await Promise.all(files.map(async (f) => ({ name: f.name, data: await base64(f) })))));
}
const importLinkedIn = () => runImport('linkedin', 'your LinkedIn export', parseLinkedIn);
const drop = (e: DragEvent) => {
  dragging.value = false;
  void importFiles(e.dataTransfer?.files ?? null);
};

// ---------- save ----------
const ERRORS: Record<string, string> = {
  master_changed: 'career/master.md changed in Obsidian since you opened this page. Load the new version, then make your change again.',
  bad_master: 'Something is not in the expected form. Dates are a year or year-month (2021 or 2021-03), the end can be “present”, and no field may hold a line break or “|”.',
};
async function save() {
  const wrong = problems(sections.value);
  if (wrong.length) return void (error.value = `Fix the dates or names first: ${wrong.join('; ')}.`);
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    show(await saveMaster(hash.value, cleaned(sections.value) as MasterSection[]));
    starting.value = false;
    warnings.value = [];
    notice.value = 'Saved to career/master.md.';
  } catch (err) {
    const code = err instanceof ApiError ? err.detail : undefined;
    error.value = (code && ERRORS[code]) || "Couldn't save. Is the server running?";
  } finally {
    busy.value = false;
  }
}
function discard() {
  sections.value = JSON.parse(saved.value) as CvSection[];
  hash.value = state.value?.exists ? state.value.hash : null;
  starting.value = false;
  error.value = null;
  notice.value = null;
  warnings.value = [];
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
  <main class="page master" @dragover.prevent="dragging = true" @dragleave.self="dragging = false" @drop.prevent="drop">
    <header class="page-head spread">
      <div>
        <h1>Master CV</h1>
        <p class="lede">Everything the app may say about you, from all your CVs in one place. Each tailored line cites a line here.</p>
      </div>
      <div class="row">
        <input ref="picker" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple class="sr-only" tabindex="-1" aria-label="Word CVs to import" @change="importFiles(($event.target as HTMLInputElement).files)" />
        <button v-if="state?.exists && 'sections' in state" type="button" :disabled="!!reading || busy" @click="importLinkedIn">{{ reading === 'linkedin' ? 'Reading your export…' : 'Import LinkedIn export' }}</button>
        <button type="button" :disabled="!!reading || busy" @click="picker?.click()">{{ reading === 'word' ? 'Reading your CVs…' : 'Import Word CVs' }}</button>
      </div>
    </header>

    <div v-if="dragging" class="dropzone" aria-hidden="true">Drop Word CVs to merge them into your master CV</div>
    <p v-if="loadError" class="notice danger" role="alert">{{ loadError }} <button type="button" @click="load">Try again</button></p>
    <p v-else-if="!state" class="placeholder" role="status">Loading…</p>

    <template v-else>
      <div v-if="error" class="notice danger" role="alert">
        <p>{{ error }} <button v-if="error.includes('Obsidian')" type="button" @click="load">Load the new version</button></p>
        <ul v-if="warnings.length"><li v-for="(w, i) in warnings" :key="i">{{ w }}</li></ul>
      </div>
      <div v-else-if="notice" class="notice ok" role="status">
        <p>{{ notice }}</p>
        <ul v-if="warnings.length"><li v-for="(w, i) in warnings" :key="i">{{ w }}</li></ul>
      </div>
      <p v-if="reading === 'word'" class="notice" role="status">Reading your CVs with the model. Your contact details are removed before anything is sent. This takes about a minute.</p>

      <div v-if="state.exists && 'error' in state && !editing" class="notice danger" role="alert">
        <p><strong>career/master.md can't be read.</strong> {{ state.error }}</p>
        <p>Fix that line in Obsidian, then load it again.</p>
        <button type="button" @click="load">Load again</button>
      </div>

      <div v-else-if="!editing" class="composer">
        <section class="notice">
          <h2>Import the CVs you have</h2>
          <p>Choose or drop one or more Word CVs. The app reads them, merges everything into one master CV without duplicates, and shows you the result to correct before saving.</p>
          <button type="button" class="primary" :disabled="!!reading" @click="picker?.click()">Import Word CVs</button>
        </section>
        <section class="notice">
          <h2>Or write it here</h2>
          <p>Start from an empty master CV. It is saved as <code>career/master.md</code> in your vault, so you can also edit it in Obsidian.</p>
          <button type="button" @click="startFresh">Start writing</button>
        </section>
      </div>

      <div v-else class="cv">
        <div>
          <CvEditor v-model="sections" />
          <div v-if="dirty" class="savebar" role="region" aria-label="Unsaved changes">
            <span>{{ counts.fresh ? `${counts.fresh} new items to check` : 'Unsaved changes' }}</span>
            <span class="row">
              <button type="button" :disabled="busy" @click="discard">Discard</button>
              <button type="button" class="primary" :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'Save' }} <kbd>Ctrl S</kbd></button>
            </span>
          </div>
        </div>
        <aside aria-label="Sections">
          <nav class="hint" aria-label="Jump to a section">
            <p class="label">{{ counts.entries }} {{ counts.entries === 1 ? 'entry' : 'entries' }} · {{ counts.lines }} {{ counts.lines === 1 ? 'line' : 'lines' }}</p>
            <p v-for="s in sections" :key="s.name">
              <a :href="`#cv-${s.name}`" @click.prevent="jump(s.name)">{{ s.name }}</a>
              · {{ isEntries(s) ? `${s.entries.length} ${s.entries.length === 1 ? 'entry' : 'entries'}` : `${s.bullets.length} ${s.bullets.length === 1 ? 'line' : 'lines'}` }}
            </p>
          </nav>
          <p class="hint">Saved as <code>career/master.md</code> in your vault. If you edit it in Obsidian too, the app notices and won't overwrite your change. Applications you already drafted keep their lines.</p>
        </aside>
      </div>
    </template>
  </main>
</template>
