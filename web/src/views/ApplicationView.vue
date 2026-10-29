<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  ApiError, archiveApplication, deleteApplication, fileUrl, renameApplication, retryApplication,
  type Draft, type DraftEdit, type FileKind, type HeaderField, type Line,
} from '../api';
import { useKeys } from '../keys';
import AddLine from '../components/AddLine.vue';
import DraftLine from '../components/DraftLine.vue';
import EntryHeader from '../components/EntryHeader.vue';
import LineSource from '../components/LineSource.vue';
import TrackingPanel from '../components/TrackingPanel.vue';
import { STEP_TEXT, statusLabel, useCareerStore, violationText } from '../stores/career';

// Everything in the application (company, role, requirements, draft, sources, tokens) is model or file output:
// it is rendered with {{ }} only. Nothing here uses v-html.
const props = defineProps<{ id: string }>();
const id = Number(props.id);
const career = useCareerStore();
const app = computed(() => (career.current?.id === id ? career.current : null));
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const busy = ref(false);
const focused = ref<string | null>(null);
const ack = ref(false);
const reading = ref<HTMLElement>();

type Row = { ref: string; label: string; line: Line; max: number };
const PIPELINE = ['intake', 'match', 'draft', 'verify'] as const;
const FILES: Record<FileKind, string> = { cv_docx: 'CV, Word', letter_docx: 'Cover letter, Word' };

const HEADER: HeaderField[] = ['org', 'title', 'start', 'end', 'location'];
/** The master's `org | title | start | end | location`, with the user's overrides on top. */
const header = (e: Draft['entries'][number]) => {
  const master = (app.value?.sources[e.entry_id] ?? '').split(' | ');
  return Object.fromEntries(HEADER.map((f, i) => [f, e.header?.[f] ?? master[i] ?? ''])) as Record<HeaderField, string>;
};
/** Removed lines are left out after numbering, so every ref keeps its index (contract §8.2). */
const kept = (rows: Row[]) => rows.filter((r) => !r.line.removed);
const doc = computed(() => {
  const d = app.value?.draft;
  if (!d) return null;
  const typed = (ref: string, label: string, text: string): Row => ({ ref, label, line: { text, cites: [] }, max: 700 });
  return {
    summary: kept(d.summary ? [{ ref: 'cv.summary', label: 'the summary', line: d.summary, max: 300 }] : []),
    entries: d.entries.flatMap((e) => {
      if (e.removed) return [];
      const h = header(e);
      const name = h.org || e.entry_id;
      const rows = e.bullets.map((line, i): Row => ({ ref: `cv.entries.${e.entry_id}.${i}`, label: `bullet ${i + 1} under ${name}`, line, max: 300 }));
      const headerEdited = app.value!.edited_refs.some((r) => r.startsWith(`cv.entries.${e.entry_id}.header.`));
      return [{ id: e.entry_id, name, header: h, headerEdited, rows: kept(rows) }];
    }),
    // Shown while empty only when editable, so a skills or languages line can be written from nothing.
    lists: [
      { title: 'Skills', row: typed('cv.skills', 'the skills', d.skills_text ?? d.skill_ids.map((s) => app.value?.sources[s] ?? s).join(', ')) },
      { title: 'Languages', row: typed('cv.languages', 'the languages', d.languages_text ?? app.value!.languages.join(', ')) },
    ].filter((l) => l.row.line.text || editable.value),
    letter: kept(d.letter.paragraphs.map((line, i): Row => ({ ref: `letter.${i}`, label: `letter paragraph ${i + 1}`, line, max: 700 }))),
  };
});
const rows = computed(() => (doc.value ? [...doc.value.summary, ...doc.value.entries.flatMap((e) => e.rows), ...doc.value.letter] : []));
/** What you removed, newest structure first, so it can be put back (op `restore`). */
const removed = computed(() => {
  const d = app.value?.draft;
  if (!d) return { cv: [], letter: [] };
  const out = (ref: string, text: string) => ({ ref, text });
  return {
    cv: [
      ...(d.summary?.removed ? [out('cv.summary', d.summary.text)] : []),
      ...d.entries.flatMap((e) => {
        const name = header(e).org || e.entry_id;
        if (e.removed) return [out(`cv.entries.${e.entry_id}`, `${name} and its lines`)];
        return e.bullets.flatMap((b, i) => (b.removed ? [out(`cv.entries.${e.entry_id}.${i}`, b.text)] : []));
      }),
    ],
    letter: d.letter.paragraphs.flatMap((p, i) => (p.removed ? [out(`letter.${i}`, p.text)] : [])),
  };
});
/** Master entries the draft doesn't have yet (live or removed), to add one. */
const addable = computed(() => {
  const inDraft = new Set(app.value?.draft?.entries.map((e) => e.entry_id));
  return (app.value?.master_entries ?? []).filter((e) => !inDraft.has(e.id)).map((e) => {
    const [org, title, start, end] = e.header.split(' | ');
    return { id: e.id, text: [org, title].filter(Boolean).join(', ') + (start ? ` (${start}–${end})` : '') };
  });
});
const toAdd = ref('');
const current = computed(() => rows.value.find((r) => r.ref === focused.value) ?? rows.value[0] ?? null);
const edited = computed(() => new Set(app.value?.edited_refs));
const violations = (ref: string) => app.value?.verify?.violations.filter((v) => v.ref === ref) ?? [];
const toCheck = computed(() => rows.value.filter((r) => !edited.value.has(r.ref) && violations(r.ref).length).length);
const editable = computed(() => app.value?.status === 'draft_ready' || app.value?.status === 'flagged');
const label = computed(() => (app.value ? statusLabel(app.value) : null));
const rendering = computed(() => label.value?.text === 'Creating files');
const stepState = (s: (typeof PIPELINE)[number]) => {
  const now = PIPELINE.indexOf(app.value?.step as (typeof PIPELINE)[number]);
  const i = PIPELINE.indexOf(s);
  return i < now ? 'Done' : i === now ? 'Now' : 'Next';
};
const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} kB`;

const ACTION_ERRORS: Record<string, string> = {
  wrong_status: 'This application changed in the meantime. Reload the page.',
  bad_ref: 'That line no longer exists. Reload the page.',
  bad_edit: 'That change was not saved: a header field takes at most 120 characters.',
  flagged_not_acknowledged: 'Tick the box first: some lines still need your check.',
  master_missing: 'There is no master CV any more. Add it on the Master CV page, then retry.',
  provider_not_configured: 'Connect a provider first (see the banner at the top).',
};
async function act(fn: () => Promise<void>) {
  busy.value = true;
  actionError.value = null;
  try {
    await fn();
  } catch (err) {
    const code = err instanceof ApiError ? err.detail : undefined;
    actionError.value = (code && ACTION_ERRORS[code]) || "That didn't work. Is the server running?";
  } finally {
    busy.value = false;
  }
}
const send = (edits: DraftEdit[], done: () => void) => act(() => career.edit(id, edits).then(done));
const save = (ref: string, text: string, done: () => void) => send([{ ref, text }], done);
const add = (ref: string, text: string, done: () => void) => send([{ op: 'add', ref, text }], done);
/** Removing can't be undone (add a line instead), so it asks first; focus then goes to the draft, not the page top. */
async function remove(ref: string, what: string) {
  if (!window.confirm(`Remove ${what}? You can't undo this.`)) return;
  await send([{ op: 'remove', ref }], () => {});
  await nextTick();
  reading.value?.focus();
}
const restore = (ref: string) => send([{ op: 'restore', ref }], () => {});
const addEntry = () => toAdd.value && send([{ op: 'add', ref: 'cv.entries', text: toAdd.value }], () => (toAdd.value = ''));
const finalise = () => act(() => career.finalise(id, ack.value));
const rerender = () => act(() => career.rerender(id));
const retry = () => act(() => career.change(() => retryApplication(id)));
const archive = (on: boolean) => act(() => career.change(() => archiveApplication(id, on)));
const router = useRouter();
async function destroy() {
  if (!window.confirm("Delete this application for good? The posting, the draft, the files and the notes are deleted. This can't be undone.")) return;
  await act(async () => {
    await deleteApplication(id);
    await router.push('/applications');
  });
}

// Rename: the model's guess at company and role can be wrong, and an application sent elsewhere may need a fix.
const naming = ref(false);
const names = ref({ role_title: '', company: '' });
async function startRename() {
  names.value = { role_title: app.value?.role_title ?? '', company: app.value?.company ?? '' };
  naming.value = true;
  await nextTick();
  document.querySelector<HTMLInputElement>('.title-edit input')?.focus();
}
const rename = () =>
  act(async () => {
    const changed = Object.fromEntries(Object.entries(names.value).map(([k, v]) => [k, v.trim()]).filter(([k, v]) => v && v !== app.value?.[k as 'company']));
    if (Object.keys(changed).length) await career.change(() => renameApplication(id, changed));
    naming.value = false;
  });
const running = computed(() => app.value?.status === 'processing' || rendering.value);

// j / k move through the draft's lines, e edits the one in focus (each line's first button carries its focus).
const lineButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.reading .line > .line-actions > button:first-child, .reading .line > button')];
const move = (by: number) => {
  const all = lineButtons();
  const at = all.findIndex((b) => b.closest('.line')?.classList.contains('focused'));
  all[Math.min(all.length - 1, Math.max(0, at + by))]?.focus();
};
useKeys({ j: () => move(1), k: () => move(-1), e: () => document.querySelector<HTMLButtonElement>('.reading .line.focused .line-actions > button')?.click() });

onMounted(() =>
  career.open(id).catch((err) => {
    loadError.value = err instanceof ApiError && err.status === 404 ? 'There is no application with this number.' : "Couldn't load this application.";
  }),
);
onUnmounted(career.stop);
</script>

<template>
  <main class="page application">
    <RouterLink to="/applications" class="back">Applications</RouterLink>
    <p v-if="loadError" class="notice danger" role="alert">{{ loadError }}</p>
    <p v-else-if="!app" class="placeholder" role="status">Loading…</p>

    <template v-else>
      <header class="app-head">
        <form v-if="naming" class="title-edit" @submit.prevent="rename" @keydown.esc.prevent="naming = false">
          <label>Role <input v-model="names.role_title" type="text" maxlength="200" required /></label>
          <label>Company <input v-model="names.company" type="text" maxlength="200" required /></label>
          <div class="row">
            <button type="submit" :disabled="busy">Save names</button>
            <button type="button" @click="naming = false">Cancel</button>
          </div>
        </form>
        <div v-else>
          <h1>{{ app.role_title ?? 'New application' }}<span v-if="app.company" class="at"> at {{ app.company }}</span></h1>
          <p class="meta">
            <span v-if="app.archived_at" class="status archived">Archived</span>
            <span class="status" :class="label!.tone">{{ label!.text }}</span>
            <span v-if="app.coverage">Covers {{ app.coverage.matched }} of {{ app.coverage.total }} must-have requirements</span>
            <span v-if="app.draft && app.draft.versions > 1">Version {{ app.draft.versions }}</span>
          </p>
        </div>
        <div v-if="!naming" class="actions">
          <button v-if="app.status === 'failed'" type="button" :disabled="busy" @click="retry">Retry</button>
          <button type="button" class="quiet" :disabled="busy || app.status === 'processing'" @click="startRename">Rename</button>
          <button type="button" class="quiet" :disabled="busy || running" @click="archive(!app.archived_at)">{{ app.archived_at ? 'Restore' : 'Archive' }}</button>
          <button type="button" class="quiet danger" :disabled="busy || running" @click="destroy">Delete</button>
        </div>
      </header>

      <section class="state" aria-live="polite" aria-label="Status">
        <p v-if="career.pollError" class="notice attention">Lost contact with the server. This shows the last known state; reload to try again.</p>

        <div v-if="app.status === 'processing'" class="notice">
          <p><strong>Working on it.</strong> This page updates by itself; you can leave it and come back.</p>
          <ol class="steps">
            <li v-for="s in PIPELINE" :key="s" :class="stepState(s).toLowerCase()">
              <span class="step-state">{{ stepState(s) }}</span> {{ STEP_TEXT[s] }}
            </li>
          </ol>
        </div>

        <div v-else-if="app.status === 'failed'" class="notice danger" role="alert">
          <p><strong>This run stopped.</strong> {{ career.failure }}</p>
          <button type="button" :disabled="busy" @click="retry">Retry with the same posting</button>
        </div>

        <div v-else-if="editable" class="notice" :class="{ attention: app.status === 'flagged' }">
          <p v-if="app.status === 'draft_ready'">
            <strong>Ready for your review.</strong> Read each line next to the master CV line it comes from, edit what you would say differently, then finalise.
          </p>
          <p v-else>
            <strong>Needs your check.</strong> After a second attempt, the fact check still marks {{ toCheck }} {{ toCheck === 1 ? 'line' : 'lines' }}
            with “Check”. Edit them, or confirm you have checked them.
          </p>
          <label v-if="app.status === 'flagged'" class="ack">
            <input v-model="ack" type="checkbox" /> I have checked the marked lines and they are true.
          </label>
          <div class="row">
            <button type="button" class="primary" :disabled="busy || (app.status === 'flagged' && !ack)" @click="finalise">Finalise and create files</button>
            <span class="hint">You can't edit the draft after this.</span>
          </div>
        </div>

        <p v-else-if="rendering" class="notice"><strong>Final.</strong> {{ STEP_TEXT.render }}…</p>
        <div v-else-if="app.fail_code === 'render_failed'" class="notice danger" role="alert">
          <p>
            <strong>Final, but the files could not be created.</strong> {{ career.failure }} The draft is unchanged<template v-if="app.files.length">, and the files below are ready</template>.
          </p>
          <button type="button" :disabled="busy" @click="rerender">Create the files again</button>
        </div>
        <p v-else-if="app.status === 'final'" class="notice ok"><strong>Final.</strong> Download the files and send them yourself; the app never sends anything.</p>

        <div v-if="app.files.length" class="downloads">
          <h2 class="label">Files</h2>
          <ul>
            <li v-for="f in app.files" :key="f.kind">
              <a :href="fileUrl(app.id, f.kind)" download>{{ FILES[f.kind] }}</a> <span class="hint">{{ kb(f.bytes) }}</span>
            </li>
          </ul>
        </div>

        <p v-if="actionError" class="notice danger" role="alert">{{ actionError }}</p>
        <p v-if="app.requirements?.injection_suspected" class="notice attention">
          The posting contains text that tries to give the model instructions. It was treated as data only; read the draft with care.
        </p>
        <p v-if="app.language === 'de'" class="notice">The posting is in German. The draft is in your master CV's language; it is not translated.</p>
      </section>

      <details v-if="app.requirements" class="asks">
        <summary>What the posting asks for</summary>
        <h3 class="label">Must have</h3>
        <ul><li v-for="r in app.requirements.must_have" :key="r.id">{{ r.text }}</li></ul>
        <template v-if="app.requirements.nice_to_have.length">
          <h3 class="label">Nice to have</h3>
          <ul><li v-for="r in app.requirements.nice_to_have" :key="r.id">{{ r.text }}</li></ul>
        </template>
      </details>

      <TrackingPanel :app="app" />

      <div v-if="doc" class="doc">
        <article ref="reading" class="reading" aria-label="Draft" tabindex="-1">
          <h2>CV</h2>
          <p v-for="(v, i) in violations('cv')" :key="i" class="tag attention">Check: the CV {{ violationText(v) }}</p>
          <ul v-if="doc.summary.length" class="lines">
            <DraftLine
              v-for="r in doc.summary" :key="r.ref" :line-ref="r.ref" :label="r.label" :line="r.line" :max="r.max"
              :focused="current?.ref === r.ref" :editable="editable" :edited="edited.has(r.ref)" :busy="busy" :violations="violations(r.ref)" removable
              @focus="focused = r.ref" @save="(t, done) => save(r.ref, t, done)" @remove="remove(r.ref, r.label)"
            >
              <LineSource v-if="current?.ref === r.ref" class="inline-source" :line="r.line" :sources="app.sources" />
            </DraftLine>
          </ul>
          <AddLine
            v-if="editable && !app.draft!.summary" id="cv-summary" label="Add a summary" button="Add a summary" :max="300" :busy="busy"
            @save="(t, done) => add('cv.summary', t, done)"
          />
          <section v-for="e in doc.entries" :key="e.id" class="entry" :aria-label="e.name">
            <EntryHeader
              :entry-id="e.id" :header="e.header" :editable="editable" :edited="e.headerEdited" :busy="busy"
              @save="send" @remove="remove(`cv.entries.${e.id}`, `${e.name} and all its lines`)"
            />
            <ul class="lines">
              <DraftLine
                v-for="r in e.rows" :key="r.ref" :line-ref="r.ref" :label="r.label" :line="r.line" :max="r.max"
                :focused="current?.ref === r.ref" :editable="editable" :edited="edited.has(r.ref)" :busy="busy" :violations="violations(r.ref)" removable
                @focus="focused = r.ref" @save="(t, done) => save(r.ref, t, done)" @remove="remove(r.ref, r.label)"
              >
                <LineSource v-if="current?.ref === r.ref" class="inline-source" :line="r.line" :sources="app.sources" />
              </DraftLine>
            </ul>
            <AddLine v-if="editable" :id="`cv-${e.id}`" :label="`Add line under ${e.name}`" :max="300" :busy="busy" @save="(t, done) => add(`cv.entries.${e.id}`, t, done)" />
          </section>
          <form v-if="editable && addable.length" class="add-row" @submit.prevent="addEntry">
            <label for="add-entry" class="hint">Add from your master CV</label>
            <select id="add-entry" v-model="toAdd">
              <option value="" disabled>Choose an entry…</option>
              <option v-for="e in addable" :key="e.id" :value="e.id">{{ e.text }}</option>
            </select>
            <button type="submit" class="quiet" :disabled="busy || !toAdd">Add entry</button>
          </form>
          <details v-if="editable && removed.cv.length" class="removed">
            <summary>Removed from the CV ({{ removed.cv.length }})</summary>
            <ul>
              <li v-for="r in removed.cv" :key="r.ref">
                <s>{{ r.text }}</s>
                <button type="button" class="quiet" :disabled="busy" @click="restore(r.ref)">Put back</button>
              </li>
            </ul>
          </details>
          <section v-for="{ title, row: r } in doc.lists" :key="r.ref" class="entry" :aria-label="title">
            <h3>{{ title }}</h3>
            <ul class="lines letter">
              <DraftLine
                :line-ref="r.ref" :label="r.label" :line="r.line" :max="r.max" :focused="false" :editable="editable" :edited="edited.has(r.ref)"
                :busy="busy" :violations="violations(r.ref)" @save="(t, done) => save(r.ref, t, done)"
              />
            </ul>
          </section>

          <h2>Cover letter</h2>
          <p v-for="(v, i) in violations('letter')" :key="i" class="tag attention">Check: the letter {{ violationText(v) }}</p>
          <ul class="lines letter">
            <DraftLine
              v-for="r in doc.letter" :key="r.ref" :line-ref="r.ref" :label="r.label" :line="r.line" :max="r.max"
              :focused="current?.ref === r.ref" :editable="editable" :edited="edited.has(r.ref)" :busy="busy" :violations="violations(r.ref)" removable
              @focus="focused = r.ref" @save="(t, done) => save(r.ref, t, done)" @remove="remove(r.ref, r.label)"
            >
              <LineSource v-if="current?.ref === r.ref" class="inline-source" :line="r.line" :sources="app.sources" />
            </DraftLine>
          </ul>
          <AddLine v-if="editable" id="letter" label="Add a paragraph to the letter" button="Add paragraph" :max="700" :busy="busy" @save="(t, done) => add('letter', t, done)" />
          <details v-if="editable && removed.letter.length" class="removed">
            <summary>Removed from the letter ({{ removed.letter.length }})</summary>
            <ul>
              <li v-for="r in removed.letter" :key="r.ref">
                <s>{{ r.text }}</s>
                <button type="button" class="quiet" :disabled="busy" @click="restore(r.ref)">Put back</button>
              </li>
            </ul>
          </details>
        </article>

        <aside v-if="current" class="source-panel" aria-label="Source of the selected line">
          <LineSource :line="current.line" :sources="app.sources" />
        </aside>
      </div>
    </template>
  </main>
</template>
