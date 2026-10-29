<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { archiveApplication, deleteApplication, type ApplicationListItem } from '../api';
import { useKeys } from '../keys';
import { nextStep, statusLabel, useCareerStore, type Group } from '../stores/career';

// Company and role are model or owner text: rendered with {{ }} only.
const career = useCareerStore();
const route = useRoute();
const router = useRouter();
const loaded = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);
const search = ref<HTMLInputElement>();

type Filter = 'all' | Group | 'archived';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'needs', label: 'Needs you' },
  { key: 'follow', label: 'Follow up' },
  { key: 'progress', label: 'In progress' },
  { key: 'done', label: 'Sent' },
  { key: 'archived', label: 'Archived' },
];
// The filter and the search live in the URL, so Back and a reload keep them.
const filter = ref<Filter>(FILTERS.some((f) => f.key === route.query.status) ? (route.query.status as Filter) : 'all');
const q = ref(typeof route.query.q === 'string' ? route.query.q : '');
watch([filter, q], () => void router.replace({ query: { ...(filter.value !== 'all' && { status: filter.value }), ...(q.value && { q: q.value }) } }));

const rows = computed(() => career.list.map((a) => ({ a, step: nextStep(a), label: statusLabel(a) })));
const inFilter = (r: (typeof rows.value)[number], f: Filter) =>
  f === 'archived' ? !!r.a.archived_at : !r.a.archived_at && (f === 'all' || r.step.group === f);
const counts = computed(() => Object.fromEntries(FILTERS.map((f) => [f.key, rows.value.filter((r) => inFilter(r, f.key)).length])));
const shown = computed(() => {
  const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.value.filter(
    (r) => inFilter(r, filter.value) && words.every((w) => `${r.a.role_title ?? ''} ${r.a.company ?? ''} ${r.label.text}`.toLowerCase().includes(w)),
  );
});

// Bulk: tidy up duplicates and failed runs.
const selected = ref(new Set<number>());
const picked = computed(() => shown.value.filter((r) => selected.value.has(r.a.id)).map((r) => r.a));
const allPicked = computed(() => shown.value.length > 0 && picked.value.length === shown.value.length);
const toggle = (id: number) => (selected.value.has(id) ? selected.value.delete(id) : selected.value.add(id));
const toggleAll = () => (selected.value = allPicked.value ? new Set() : new Set(shown.value.map((r) => r.a.id)));
const running = (a: ApplicationListItem) => a.status === 'processing' || (a.status === 'final' && a.step === 'render');

async function bulk(fn: (a: ApplicationListItem) => Promise<unknown>) {
  busy.value = true;
  error.value = null;
  const targets = picked.value.filter((a) => !running(a));
  const results = await Promise.allSettled(targets.map(fn));
  const failed = results.filter((r) => r.status === 'rejected').length;
  const skipped = picked.value.length - targets.length;
  if (failed || skipped)
    error.value = [failed && `${failed} could not be changed`, skipped && `${skipped} still running, left as they are`].filter(Boolean).join('; ') + '.';
  selected.value = new Set();
  await career.load().catch(() => {});
  busy.value = false;
}
const archive = (on: boolean) => bulk((a) => archiveApplication(a.id, on));
function remove() {
  const n = picked.value.length;
  if (window.confirm(`Delete ${n === 1 ? 'this application' : `${n} applications`} for good? The posting, the draft, the files and the notes are deleted. This can't be undone.`))
    void bulk((a) => deleteApplication(a.id));
}

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
useKeys({ '/': () => search.value?.focus() });
onMounted(() => career.load().catch(() => (error.value = "Couldn't load the applications. Is the server running?")).finally(() => (loaded.value = true)));
</script>

<template>
  <main class="page">
    <header class="page-head spread">
      <h1>Applications</h1>
      <RouterLink v-slot="{ navigate }" to="/new" custom>
        <button type="button" class="primary" @click="navigate">New application</button>
      </RouterLink>
    </header>

    <div class="toolbar">
      <div class="search">
        <label for="q" class="sr-only">Search role, company or status</label>
        <input id="q" ref="search" v-model="q" type="search" placeholder="Search role, company or status" autocomplete="off" @keydown.esc="q = ''" />
        <kbd v-if="!q" aria-hidden="true">/</kbd>
      </div>
      <div class="chips" role="group" aria-label="Show">
        <button v-for="f in FILTERS" :key="f.key" type="button" :aria-pressed="filter === f.key" @click="filter = f.key">
          {{ f.label }}<span class="n">{{ counts[f.key] }}</span>
        </button>
      </div>
    </div>

    <p v-if="error" class="notice danger" role="alert">{{ error }}</p>

    <div v-if="picked.length" class="bulk" role="region" aria-label="Selected applications">
      <strong>{{ picked.length }} selected</strong>
      <span class="row">
        <button v-if="filter === 'archived'" type="button" :disabled="busy" @click="archive(false)">Restore</button>
        <button v-else type="button" :disabled="busy" @click="archive(true)">Archive</button>
        <button type="button" class="danger" :disabled="busy" @click="remove">Delete</button>
        <button type="button" class="quiet" @click="selected = new Set()">Clear</button>
      </span>
    </div>

    <div v-if="loaded && !career.list.length" class="notice">
      <h2>No applications yet</h2>
      <p>Paste a job posting and the app drafts a CV and a cover letter from your master CV, with a source for every line.</p>
      <RouterLink to="/new">Start the first one</RouterLink>
    </div>
    <p v-else-if="loaded && !shown.length" class="placeholder">
      Nothing matches. <button type="button" class="quiet" @click="(q = ''), (filter = 'all')">Show all</button>
    </p>
    <table v-else-if="shown.length" class="ledger">
      <thead>
        <tr>
          <th scope="col" class="check"><input type="checkbox" :checked="allPicked" aria-label="Select all shown" @change="toggleAll" /></th>
          <th scope="col">Role and company</th><th scope="col">Status</th><th scope="col" class="wide">Next</th>
          <th scope="col" class="num wide">Updated</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="{ a, step, label } in shown" :key="a.id" :class="{ 'is-archived': a.archived_at }">
          <td class="check">
            <input type="checkbox" :checked="selected.has(a.id)" :aria-label="`Select ${a.role_title ?? `application ${a.id}`}`" @change="toggle(a.id)" />
          </td>
          <td class="role">
            <RouterLink :to="`/applications/${a.id}`">{{ a.role_title ?? `Application ${a.id}` }}</RouterLink>
            <span class="hint">{{ a.company ?? 'Company not known yet' }}</span>
          </td>
          <td>
            <span v-if="a.archived_at" class="status archived">Archived</span>
            <span v-else class="status" :class="label.tone">{{ label.text }}</span>
          </td>
          <td class="wide hint">{{ step.text }}</td>
          <td class="num wide"><time :datetime="a.updated_at">{{ date(a.updated_at) }}</time></td>
        </tr>
      </tbody>
    </table>
  </main>
</template>
