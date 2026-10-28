<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ApiError, fileUrl, type FileKind, type Line } from '../api';
import DraftLine from '../components/DraftLine.vue';
import LineSource from '../components/LineSource.vue';
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

type Row = { ref: string; label: string; line: Line; max: number };
const PIPELINE = ['intake', 'match', 'draft', 'verify'] as const;
const FILES: Record<FileKind, string> = { cv_docx: 'CV, Word', cv_pdf: 'CV, PDF', letter_docx: 'Cover letter, Word', letter_pdf: 'Cover letter, PDF' };

const header = (entryId: string) => {
  const [org, title, dates] = (app.value?.sources[entryId] ?? '').split(' | ');
  return { org: org || entryId, title: title ?? '', dates: dates ?? '' };
};
const doc = computed(() => {
  const d = app.value?.draft;
  if (!d) return null;
  return {
    summary: d.summary ? [{ ref: 'cv.summary', label: 'the summary', line: d.summary, max: 300 }] : [],
    entries: d.entries.map((e) => {
      const h = header(e.entry_id);
      const rows = e.bullets.map((line, i): Row => ({ ref: `cv.entries.${e.entry_id}.${i}`, label: `bullet ${i + 1} under ${h.org}`, line, max: 300 }));
      return { id: e.entry_id, ...h, rows };
    }),
    skills: d.skill_ids.map((s) => app.value?.sources[s] ?? s),
    letter: d.letter.paragraphs.map((line, i): Row => ({ ref: `letter.${i}`, label: `letter paragraph ${i + 1}`, line, max: 700 })),
  };
});
const rows = computed(() => (doc.value ? [...doc.value.summary, ...doc.value.entries.flatMap((e) => e.rows), ...doc.value.letter] : []));
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
  flagged_not_acknowledged: 'Tick the box first: some lines still need your check.',
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
const save = (ref: string, text: string, done: () => void) => act(() => career.edit(id, ref, text).then(done));
const finalise = () => act(() => career.finalise(id, ack.value));
const rerender = () => act(() => career.rerender(id));

onMounted(() =>
  career.open(id).catch((err) => {
    loadError.value = err instanceof ApiError && err.status === 404 ? 'There is no application with this number.' : "Couldn't load this application.";
  }),
);
onUnmounted(career.stop);
</script>

<template>
  <main class="page application">
    <RouterLink to="/applications" class="back">All applications</RouterLink>
    <p v-if="loadError" class="notice danger" role="alert">{{ loadError }}</p>
    <p v-else-if="!app" class="placeholder" role="status">Loading…</p>

    <template v-else>
      <header class="app-head">
        <h1>
          {{ app.role_title ?? 'New application' }}<span v-if="app.company" class="at"> at {{ app.company }}</span>
        </h1>
        <p class="meta">
          <span class="status" :class="label!.tone">{{ label!.text }}</span>
          <span v-if="app.coverage">Covers {{ app.coverage.matched }} of {{ app.coverage.total }} must-have requirements</span>
          <span v-if="app.draft && app.draft.versions > 1">Version {{ app.draft.versions }}</span>
        </p>
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
          <p>Paste the posting again on <RouterLink to="/applications">Applications</RouterLink> to start a new run.</p>
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
            <strong>Final, but the export failed.</strong> {{ career.failure }} The draft is unchanged<template v-if="app.files.length">, and the files below are ready</template>.
          </p>
          <button type="button" :disabled="busy" @click="rerender">Retry export</button>
        </div>
        <p v-else-if="app.status === 'final'" class="notice ok"><strong>Final.</strong> Download the files and send them yourself; the app never sends anything.</p>

        <div v-if="app.files.length" class="downloads">
          <h2 class="label">Files</h2>
          <ul>
            <li v-for="f in app.files" :key="f.kind">
              <a :href="fileUrl(app.id, f.kind)" download>{{ FILES[f.kind] }}</a> <span class="hint">{{ kb(f.bytes) }}</span>
            </li>
          </ul>
          <p v-if="app.render_warnings.includes('cv_over_2_pages')" class="notice attention">
            The CV runs past two pages. Check it in Word before you send it.
          </p>
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

      <div v-if="doc" class="doc">
        <article class="reading" aria-label="Draft">
          <h2>CV</h2>
          <p v-for="(v, i) in violations('cv')" :key="i" class="tag attention">Check: the CV {{ violationText(v) }}</p>
          <ul v-if="doc.summary.length" class="lines">
            <DraftLine
              v-for="r in doc.summary" :key="r.ref" :line-ref="r.ref" :label="r.label" :line="r.line" :max="r.max"
              :focused="current?.ref === r.ref" :editable="editable" :edited="edited.has(r.ref)" :busy="busy" :violations="violations(r.ref)"
              @focus="focused = r.ref" @save="(t, done) => save(r.ref, t, done)"
            >
              <LineSource v-if="current?.ref === r.ref" class="inline-source" :line="r.line" :sources="app.sources" />
            </DraftLine>
          </ul>
          <section v-for="e in doc.entries" :key="e.id" class="entry" :aria-label="e.org">
            <h3>{{ e.org }}<span v-if="e.title" class="entry-title"> · {{ e.title }}</span></h3>
            <p v-if="e.dates" class="hint">{{ e.dates }}</p>
            <ul class="lines">
              <DraftLine
                v-for="r in e.rows" :key="r.ref" :line-ref="r.ref" :label="r.label" :line="r.line" :max="r.max"
                :focused="current?.ref === r.ref" :editable="editable" :edited="edited.has(r.ref)" :busy="busy" :violations="violations(r.ref)"
                @focus="focused = r.ref" @save="(t, done) => save(r.ref, t, done)"
              >
                <LineSource v-if="current?.ref === r.ref" class="inline-source" :line="r.line" :sources="app.sources" />
              </DraftLine>
            </ul>
          </section>
          <section v-if="doc.skills.length" class="entry" aria-label="Skills">
            <h3>Skills</h3>
            <p v-for="(v, i) in violations('cv.skills')" :key="i" class="tag attention">Check: the skills {{ violationText(v) }}</p>
            <p>{{ doc.skills.join(' · ') }}</p>
          </section>

          <h2>Cover letter</h2>
          <p v-for="(v, i) in violations('letter')" :key="i" class="tag attention">Check: the letter {{ violationText(v) }}</p>
          <ul class="lines letter">
            <DraftLine
              v-for="r in doc.letter" :key="r.ref" :line-ref="r.ref" :label="r.label" :line="r.line" :max="r.max"
              :focused="current?.ref === r.ref" :editable="editable" :edited="edited.has(r.ref)" :busy="busy" :violations="violations(r.ref)"
              @focus="focused = r.ref" @save="(t, done) => save(r.ref, t, done)"
            >
              <LineSource v-if="current?.ref === r.ref" class="inline-source" :line="r.line" :sources="app.sources" />
            </DraftLine>
          </ul>
        </article>

        <aside v-if="current" class="source-panel" aria-label="Source of the selected line">
          <LineSource :line="current.line" :sources="app.sources" />
        </aside>
      </div>
    </template>
  </main>
</template>
