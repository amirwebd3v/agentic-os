<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import {
  ApiError, archiveApplication, checkAts, deleteApplication, dismissSuggestions, editPosting, fileUrl, refreshPart, renameApplication, restoreDraft,
  retryApplication, sendAnswers,
  type FileKind, type Line, type Suggestion,
} from '../api';
import CvEditor from '../components/CvEditor.vue';
import FitPanel from '../components/FitPanel.vue';
import LetterBrief from '../components/LetterBrief.vue';
import { addToMaster, type MasterTarget } from '../masterAdd';
import LineSource from '../components/LineSource.vue';
import TrackingPanel from '../components/TrackingPanel.vue';
import { allLines, blankSection, cleaned, isEntries, problems, type CvSection, type SectionName } from '../cv';
import { STEP_TEXT, statusLabel, useCareerStore, violationText } from '../stores/career';

// Everything in the application (company, role, requirements, draft, sources, tokens) is model, file or owner text:
// it is rendered with {{ }} and v-model only. Nothing here uses v-html.
const props = defineProps<{ id: string }>();
const id = Number(props.id);
const career = useCareerStore();
const router = useRouter();
const app = computed(() => (career.current?.id === id ? career.current : null));
const loadError = ref<string | null>(null);
const actionError = ref<string | null>(null);
const busy = ref(false);
const ack = ref(false);
const focused = ref<string | null>(null);

type Tab = 'cv' | 'letter' | 'fit' | 'posting' | 'tracking';
const tab = ref<Tab>('cv');
const FILES: Record<FileKind, string> = { cv_docx: 'CV, Word', letter_docx: 'Cover letter, Word' };
const PIPELINE = ['intake', 'match', 'gaps', 'draft', 'verify', 'ats', 'company', 'vacancy', 'questions', 'letter'] as const;

// ---------- the draft: a local copy edited in place, saved as a whole ----------
const sections = ref<CvSection[]>([]);
const paragraphs = ref<Line[]>([]);
const saved = ref('');
/** A plain copy: the store's detail is reactive, which structuredClone can't copy. */
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const snapshot = () => JSON.stringify([sections.value, paragraphs.value]);
const dirty = computed(() => !!app.value?.draft && snapshot() !== saved.value);
watch(
  () => app.value?.draft,
  (d) => {
    if (!d || (saved.value && dirty.value)) return; // never throw away unsaved edits when a poll brings a new detail
    sections.value = clone(d.cv.sections);
    paragraphs.value = clone(d.letter.paragraphs);
    saved.value = snapshot();
  },
  { immediate: true },
);
const editable = computed(() => app.value?.status === 'draft_ready' || app.value?.status === 'flagged');
const lines = computed(() => [...allLines(sections.value), ...paragraphs.value]);
const current = computed(() => lines.value.find((l) => l.id && l.id === focused.value) ?? null);
const edited = computed(() => new Set(app.value?.edited_refs));
const violations = (ref?: string) => (ref ? app.value?.verify?.violations.filter((v) => v.ref === ref) ?? [] : []);
const toCheck = computed(() => lines.value.filter((l) => l.id && !edited.value.has(l.id) && violations(l.id).length).length);
const docViolations = computed(() => app.value?.verify?.violations.filter((v) => !v.ref.startsWith('l-')) ?? []);

const ACTION_ERRORS: Record<string, string> = {
  wrong_status: 'This application changed in the meantime. Reload the page.',
  draft_changed: 'The draft changed since you opened it (another tab?). Reload to get the latest version; your unsaved edits are lost.',
  bad_draft: 'Something is not in the expected form: every line needs text, dates are 2021 or 2021-03 (or “present”), and no field may hold “|”.',
  flagged_not_acknowledged: 'Tick the box first: some lines still need your check.',
  master_missing: 'There is no master CV any more. Add it on the Master CV page, then retry.',
  master_changed: 'Your master CV changed in Obsidian meanwhile, so the line was not added there. Add it on the Master CV page.',
  provider_error: 'The model provider returned an error. Try again in a moment.',
  bad_answers: 'Those answers no longer match the questions. Reload the page.',
  unknown_suggestion: 'That suggestion no longer exists. Reload the page.',
  provider_not_configured: 'Connect a provider first (see the banner at the top).',
  busy: 'A step is still running. Wait until it finishes.',
  archived: 'Restore the application from the archive first.',
  posting_too_long: 'The posting is longer than 30,000 characters. Paste only the job description.',
  research_too_long: 'Your company notes are longer than 20,000 characters. Keep the parts that matter.',
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
async function save() {
  const wrong = problems(sections.value, true);
  if (wrong.length) return void (actionError.value = `Fix the dates or names first: ${wrong.join('; ')}.`);
  const letter = paragraphs.value.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => p.text);
  await act(async () => {
    const d = app.value!.draft!;
    saved.value = ''; // let the new detail replace the local copy
    await career.edit(id, { versions: d.versions, cv: { sections: cleaned(sections.value) }, letter: { paragraphs: letter } });
    sections.value = clone(app.value!.draft!.cv.sections);
    paragraphs.value = clone(app.value!.draft!.letter.paragraphs);
    saved.value = snapshot();
  });
}
function discard() {
  const d = app.value?.draft;
  if (!d) return;
  sections.value = clone(d.cv.sections);
  paragraphs.value = clone(d.letter.paragraphs);
  actionError.value = null;
}
function move<T>(list: T[], i: number, by: number) {
  const j = i + by;
  if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j]!, list[i]!];
}
async function addParagraph() {
  paragraphs.value.push({ text: '' });
  await nextTick();
  [...document.querySelectorAll<HTMLTextAreaElement>('.letter-edit textarea')].at(-1)?.focus();
}
// ---------- gaps, ATS and the letter agent ----------
const recheck = () => act(() => career.change(() => checkAts(id)));
const dismiss = (ids: string[]) => act(() => career.change(() => dismissSuggestions(id, ids)));
const answer = (answers: { id: string; text: string | null }[]) => act(() => career.change(() => sendAnswers(id, answers)));
const toMaster = (t: MasterTarget, text: string) =>
  act(async () => {
    if (!(await addToMaster(t, text))) actionError.value = 'That part of your master CV no longer exists. Add the line on the Master CV page.';
  });
/** A confirmed suggestion goes into the draft as a new line (saved with the next Save) and, if asked, into the master. */
async function accept(sg: Suggestion, text: string, alsoMaster: boolean) {
  const line: Line = { text, origin: 'suggestion', suggestion_id: sg.id };
  const entry = sections.value.flatMap((x) => (isEntries(x) ? x.entries : [])).find((e) => sg.entry_id && (e.source === sg.entry_id || e.id === sg.entry_id));
  if (entry) entry.bullets.push(line);
  else {
    const name = (SECTION_NAMES.includes(sg.section as SectionName) ? sg.section : 'Summary') as SectionName;
    let sec = sections.value.find((x) => x.name === name);
    if (!sec) sections.value.push((sec = blankSection(name)));
    if (isEntries(sec)) (sec.entries[0] ?? sec.entries[sec.entries.push({ org: '', title: '', start: '', end: '', location: '', bullets: [] }) - 1]!).bullets.push(line);
    else sec.bullets = [...sec.bullets.filter((b) => b.text.trim()), line];
  }
  tab.value = 'cv';
  if (alsoMaster) await toMaster(sg.entry_id ? { entry: sg.entry_id } : { section: name4master(sg.section) }, text);
}
const SECTION_NAMES: readonly string[] = ['Summary', 'Experience', 'Education', 'Projects', 'Certifications', 'Skills', 'Languages'];
const name4master = (section: string) => (section === 'Skills' || section === 'Languages' ? section : 'Summary') as 'Summary' | 'Skills' | 'Languages';

const words = computed(() => paragraphs.value.map((p) => p.text).join(' ').split(/\s+/).filter(Boolean).length);

// ---------- status and actions ----------
const label = computed(() => (app.value ? statusLabel(app.value) : null));
const rendering = computed(() => label.value?.text === 'Creating files');
const running = computed(() => app.value?.status === 'processing' || rendering.value);
/** Only the steps this run goes through: a re-read stops at gaps, a CV refresh at ats, a letter refresh starts at company. */
const runSteps = computed(() => {
  const run = app.value?.run;
  const end = run?.stop ? PIPELINE.indexOf(run.stop) + 1 : PIPELINE.length;
  return PIPELINE.slice(run ? PIPELINE.indexOf(run.from) : 0, end);
});
const stepState = (s: (typeof PIPELINE)[number]) => {
  const now = PIPELINE.indexOf(app.value?.step as (typeof PIPELINE)[number]);
  const i = PIPELINE.indexOf(s);
  return i < now ? 'Done' : i === now ? 'Now' : 'Next';
};
const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} kB`;
const finalise = () => (dirty.value ? void (actionError.value = 'Save or discard your changes first.') : act(() => career.finalise(id, ack.value)));
const rerender = () => act(() => career.rerender(id));
const retry = () => act(() => career.change(() => retryApplication(id)));
const archive = (on: boolean) => act(() => career.change(() => archiveApplication(id, on)));
async function destroy() {
  if (!window.confirm("Delete this application for good? The posting, the draft, the files and the notes are deleted. This can't be undone.")) return;
  await act(async () => {
    await deleteApplication(id);
    saved.value = snapshot();
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

// ---------- #72, #73: edit the posting, refresh a part, out-of-date banners ----------
const sent = computed(() => !!app.value && ['applied', 'withdrawn'].includes(app.value.status));
/** Why the refresh buttons are off, or null. The server refuses the same cases (`busy`, `archived`). */
const refreshBlock = computed(() => {
  if (running.value) return 'Wait until the current step finishes.';
  if (app.value?.archived_at) return 'Restore the application from the archive first.';
  if (dirty.value) return 'Save or discard your changes first.';
  return null;
});
const STALE_CV = { posting: 'Out of date: the posting changed', master: 'Out of date: your master CV changed' } as const;
const STALE_LETTER = { posting: 'Out of date: the posting changed', context: 'Out of date: the company details changed', cv: 'Out of date: the CV changed' } as const;
/** Files made before the draft went back to review are from the old version. */
const oldFiles = computed(() => !!app.value?.files.length && !['final', 'applied', 'withdrawn'].includes(app.value.status));
const refresh = (part: 'posting' | 'cv' | 'letter') => {
  if (part === 'letter' && !window.confirm('Start the cover letter over? Your answers to its questions are discarded and the questions are asked again.')) return;
  return act(() => career.change(() => refreshPart(id, part)));
};
const TAB_ACTION = { posting: 'Re-read posting', cv: 'Refresh CV', letter: 'Refresh letter' } as const;
/** The tab's refresh (#73): the posting always, the CV and letter once there is a draft. */
const tabPart = computed(() => {
  if (sent.value || !app.value) return null;
  if (tab.value === 'posting') return 'posting';
  return (tab.value === 'cv' || tab.value === 'letter') && app.value.draft ? tab.value : null;
});
const staleText = computed(() => {
  const s = app.value?.stale;
  if (tab.value === 'cv' && s?.cv) return STALE_CV[s.cv];
  return tab.value === 'letter' && s?.letter ? STALE_LETTER[s.letter] : null;
});
const restore = () => {
  if (!window.confirm("Put the previous CV back? The refreshed CV is replaced and can't be brought back.")) return;
  return act(() => career.change(() => restoreDraft(id, app.value!.draft!.versions)));
};

const posting = ref({ posting: '', company_name: '', company_website: '', research: '', target_country: '' });
const postingFrom = () => ({
  posting: app.value?.posting ?? '',
  company_name: app.value?.context?.company_name ?? '',
  company_website: app.value?.context?.company_website ?? '',
  research: app.value?.context?.research ?? '',
  target_country: app.value?.context?.target_country ?? '',
});
const postingSaved = ref('');
const postingDirty = computed(() => JSON.stringify(posting.value) !== postingSaved.value);
const resetPosting = () => {
  posting.value = postingFrom();
  postingSaved.value = JSON.stringify(posting.value);
};
// A poll never throws away an unsaved posting edit.
watch(() => [app.value?.posting, app.value?.context], () => (postingSaved.value && postingDirty.value ? undefined : resetPosting()), { immediate: true });
const savePosting = () =>
  act(async () => {
    const { posting: text, ...rest } = posting.value;
    const extra = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    await career.change(() => editPosting(id, { posting: text, ...extra }));
    resetPosting();
  });

const tracked = computed(() => !!app.value && ['final', 'applied', 'withdrawn'].includes(app.value.status));
const TABS = computed(() =>
  [
    { key: 'cv', label: 'CV', show: !!app.value?.draft },
    { key: 'letter', label: 'Cover letter', show: !!app.value?.draft || !!app.value?.questions },
    { key: 'fit', label: 'Fit and ATS', show: !!app.value?.gaps || !!app.value?.ats },
    { key: 'posting', label: 'The posting', show: !!app.value?.requirements || !!app.value?.posting },
    { key: 'tracking', label: 'Tracking', show: tracked.value },
  ].filter((t) => t.show) as { key: Tab; label: string }[],
);
watch(TABS, (t) => {
  if (t.length && !t.some((x) => x.key === tab.value)) tab.value = t[0]!.key;
}, { immediate: true });

const onKey = (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && dirty.value) {
    e.preventDefault();
    void save();
  }
};
const beforeUnload = (e: BeforeUnloadEvent) => dirty.value && e.preventDefault();
onBeforeRouteLeave(() => !dirty.value || window.confirm('Leave without saving your changes to this draft?'));
onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', beforeUnload);
  career.open(id).catch((err) => {
    loadError.value = err instanceof ApiError && err.status === 404 ? 'There is no application with this number.' : "Couldn't load this application.";
  });
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('beforeunload', beforeUnload);
  career.stop();
});
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
            <li v-for="s in runSteps" :key="s" :class="stepState(s).toLowerCase()">
              <span class="step-state">{{ stepState(s) }}</span> {{ STEP_TEXT[s] }}
            </li>
          </ol>
        </div>

        <div v-else-if="app.status === 'needs_answers'" class="notice attention">
          <p><strong>Waiting for your answers.</strong> The CV is drafted. Before writing the cover letter, the agent needs a few facts your CVs don't show.</p>
          <button type="button" class="primary" @click="tab = 'letter'">Answer the questions</button>
        </div>

        <div v-else-if="app.status === 'failed'" class="notice danger" role="alert">
          <p><strong>This run stopped.</strong> {{ career.failure }}</p>
          <button type="button" :disabled="busy" @click="retry">Retry with the same posting</button>
        </div>

        <div v-else-if="editable" class="notice" :class="{ attention: app.status === 'flagged' }">
          <p v-if="app.status === 'draft_ready'">
            <strong>Ready for your review.</strong> Read each line beside the master CV line it comes from, change anything, then finalise.
          </p>
          <p v-else>
            <strong>Needs your check.</strong>
            <template v-if="toCheck">The fact check still marks {{ toCheck }} {{ toCheck === 1 ? 'line' : 'lines' }} with “Check”.</template>
            <template v-for="(v, i) in docViolations" :key="i"> The {{ v.ref.startsWith('letter') ? 'letter' : 'CV' }} {{ violationText(v) }}.</template>
            Edit it, or confirm you have checked it.
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
          <p><strong>Final, but the files could not be created.</strong> {{ career.failure }} The draft is unchanged.</p>
          <button type="button" :disabled="busy" @click="rerender">Create the files again</button>
        </div>
        <p v-else-if="app.status === 'final'" class="notice ok"><strong>Final.</strong> Download the files and send them yourself; the app never sends anything.</p>

        <ul v-if="app.files.length" class="downloads">
          <li v-for="f in app.files" :key="f.kind"><a :href="fileUrl(app.id, f.kind)" download>{{ FILES[f.kind] }} <span class="hint">{{ kb(f.bytes) }}</span></a></li>
        </ul>
        <p v-if="oldFiles" class="notice attention">
          <strong>These files are from the old version.</strong> The draft changed after you finalised it; finalise again to create new files.
        </p>

        <p v-if="actionError" class="notice danger" role="alert">{{ actionError }}</p>
        <p v-if="app.requirements?.injection_suspected" class="notice attention">
          The posting contains text that tries to give the model instructions. It was treated as data only; read the draft with care.
        </p>
      </section>

      <div v-if="TABS.length > 1" class="seg tabs" role="group" aria-label="Parts of this application">
        <button v-for="t in TABS" :key="t.key" type="button" :aria-pressed="tab === t.key" @click="tab = t.key">{{ t.label }}</button>
      </div>

      <div v-if="tabPart" class="tab-head">
        <div v-if="staleText" class="notice attention" role="status">
          <p><strong>{{ staleText }}.</strong> {{ tabPart === 'cv' ? 'Your own lines are kept.' : 'The answers to its questions are asked again.' }}</p>
          <button type="button" :disabled="busy || !!refreshBlock" @click="refresh(tabPart)">Refresh</button>
        </div>
        <span class="row tab-actions">
          <span v-if="refreshBlock" class="hint">{{ refreshBlock }}</span>
          <button v-if="tabPart === 'cv' && app.can_restore" type="button" class="quiet" :disabled="busy || !!refreshBlock || !editable" @click="restore">
            Restore previous version
          </button>
          <button v-if="!staleText" type="button" class="quiet" :disabled="busy || !!refreshBlock" @click="refresh(tabPart)">{{ TAB_ACTION[tabPart] }}</button>
        </span>
      </div>

      <div v-if="tab === 'cv' && app.draft" class="doc">
        <div class="reading">
          <p v-for="(v, i) in docViolations" :key="i" class="tag attention">Check: the {{ v.ref.startsWith('letter') ? 'letter' : 'CV' }} {{ violationText(v) }}</p>
          <CvEditor v-model="sections" :editable="editable" :focused="focused" id-prefix="draft" @focus="(l) => (focused = l.id ?? null)">
            <template #meta="{ line }">
              <p v-if="line.id && edited.has(line.id)" class="line-meta"><span class="tag">Edited by you, not re-checked</span></p>
              <p v-else-if="line.origin === 'owner' || (!line.id && editable)" class="line-meta"><span class="tag">Your own line, not checked</span></p>
              <p v-else-if="line.origin === 'suggestion'" class="line-meta"><span class="tag">From a suggestion you confirmed</span></p>
              <p v-else-if="violations(line.id).length" class="line-meta">
                <span v-for="(v, i) in violations(line.id)" :key="i" class="tag attention">Check: this line {{ violationText(v) }}</span>
              </p>
            </template>
          </CvEditor>
        </div>
        <aside class="source-panel" aria-label="Source of the selected line">
          <LineSource v-if="current" :line="current" :sources="app.sources" />
          <p v-else class="hint">Select a line to see the master CV line it comes from and what changed.</p>
        </aside>
      </div>

      <FitPanel v-else-if="tab === 'fit'" :app="app" :editable="editable" :busy="busy" :dirty="dirty" @recheck="recheck" @dismiss="dismiss" @accept="accept" />

      <section v-else-if="tab === 'letter'" class="letter-tab" aria-label="Cover letter">
        <LetterBrief :app="app" :busy="busy" @answer="answer" @to-master="toMaster" />
        <p class="hint">{{ words }} words · aim for 250 to 350.</p>
        <ol class="lines letter-edit">
          <li v-for="(p, i) in paragraphs" :key="p.id ?? `new-${i}`" class="cv-item" :class="{ focused: p.id && p.id === focused }" @focusin="focused = p.id ?? null">
            <textarea v-if="editable" v-model="p.text" rows="3" maxlength="2000" :aria-label="`Letter paragraph ${i + 1}`"></textarea>
            <p v-else class="line-text">{{ p.text }}</p>
            <span v-if="editable" class="cv-tools">
              <button type="button" class="quiet" :aria-label="`Move paragraph ${i + 1} up`" :disabled="i === 0" @click="move(paragraphs, i, -1)">Up</button>
              <button type="button" class="quiet" :aria-label="`Move paragraph ${i + 1} down`" :disabled="i === paragraphs.length - 1" @click="move(paragraphs, i, 1)">Down</button>
              <button type="button" class="quiet danger" :aria-label="`Remove paragraph ${i + 1}`" @click="paragraphs.splice(i, 1)">Remove</button>
            </span>
            <p v-if="p.id && violations(p.id).length" class="line-meta">
              <span v-for="(v, k) in violations(p.id)" :key="k" class="tag attention">Check: this paragraph {{ violationText(v) }}</span>
            </p>
          </li>
        </ol>
        <p v-if="!paragraphs.length" class="hint">The letter is written after the CV, once any questions are answered.</p>
        <button v-if="editable" type="button" class="quiet" @click="addParagraph">Add paragraph</button>
      </section>

      <section v-else-if="tab === 'posting'" class="asks" aria-label="What the posting asks for">
        <template v-if="app.requirements">
          <h2>Must have</h2>
          <ul><li v-for="r in app.requirements.must_have" :key="r.id">{{ r.text }}</li></ul>
          <template v-if="app.requirements.nice_to_have.length">
            <h2>Nice to have</h2>
            <ul><li v-for="r in app.requirements.nice_to_have" :key="r.id">{{ r.text }}</li></ul>
          </template>
        </template>
        <form v-if="app.posting !== null && app.posting !== undefined && !sent" class="posting-edit" @submit.prevent="savePosting">
          <h2>The posting</h2>
          <label>Posting <textarea v-model="posting.posting" rows="12" maxlength="30000" required></textarea></label>
          <label>Company <input v-model="posting.company_name" type="text" maxlength="200" /></label>
          <label>Website <input v-model="posting.company_website" type="text" maxlength="500" /></label>
          <label>Target country <input v-model="posting.target_country" type="text" maxlength="100" /></label>
          <label>Your notes on the company <textarea v-model="posting.research" rows="5" maxlength="20000"></textarea></label>
          <div class="row">
            <button type="submit" :disabled="busy || !postingDirty || !!refreshBlock || !posting.posting.trim()">Save the posting</button>
            <button v-if="postingDirty" type="button" class="quiet" @click="resetPosting">Discard</button>
            <span class="hint">A changed posting is read again; the CV and letter are then out of date.</span>
          </div>
        </form>
      </section>

      <TrackingPanel v-else-if="tab === 'tracking'" :app="app" />

      <div v-if="dirty" class="savebar" role="region" aria-label="Unsaved changes">
        <span>Unsaved changes to the draft</span>
        <span class="row">
          <button type="button" :disabled="busy" @click="discard">Discard</button>
          <button type="button" class="primary" :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'Save' }} <kbd>Ctrl S</kbd></button>
        </span>
      </div>
    </template>
  </main>
</template>
