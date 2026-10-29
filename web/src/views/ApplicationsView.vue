<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError, createApplication, createManualApplication } from '../api';
import MasterImport from '../components/MasterImport.vue';
import { dayText, MILESTONE_TEXT, statusLabel, today, useCareerStore } from '../stores/career';

const MAX = 30_000; // contract §8.2
const career = useCareerStore();
const router = useRouter();
const posting = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const needsMaster = ref(false);
const loaded = ref(false);

const ERRORS: Record<string, string> = {
  master_missing: 'There is no master CV yet. Import one, approve it in Review, then paste the posting again.',
  provider_not_configured: 'Connect a provider first (see the banner at the top).',
  posting_too_long: `The posting is longer than ${MAX.toLocaleString('en')} characters. Paste only the job description.`,
};

async function start() {
  busy.value = true;
  error.value = null;
  try {
    const { id } = await createApplication(posting.value);
    await router.push(`/applications/${id}`);
  } catch (err) {
    const code = err instanceof ApiError ? err.detail : undefined;
    needsMaster.value = code === 'master_missing';
    error.value = (code && ERRORS[code]) || "Couldn't start. Is the server running?";
  } finally {
    busy.value = false;
  }
}

// An application sent outside the app: tracked here, no draft.
const manual = ref({ company: '', role_title: '', applied_on: today() });
const manualError = ref<string | null>(null);
async function addManual() {
  busy.value = true;
  manualError.value = null;
  try {
    const { id } = await createManualApplication(manual.value);
    await router.push(`/applications/${id}`);
  } catch (err) {
    manualError.value = err instanceof ApiError && err.detail === 'bad_date' ? 'That is not a valid date.' : "Couldn't add it. Is the server running?";
  } finally {
    busy.value = false;
  }
}

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

onMounted(() => career.load().catch(() => (error.value = "Couldn't load the applications.")).finally(() => (loaded.value = true)));
</script>

<template>
  <main class="page">
    <h1>Applications</h1>

    <form class="new-posting" @submit.prevent="start">
      <label for="posting">New application: paste the job posting</label>
      <textarea
        id="posting"
        v-model="posting"
        rows="7"
        :maxlength="MAX"
        aria-describedby="posting-hint"
        placeholder="Job title, company, requirements…"
      ></textarea>
      <div class="row">
        <button type="submit" class="primary" :disabled="busy || !posting.trim()">
          {{ busy ? 'Starting…' : 'Tailor CV and letter' }}
        </button>
        <span id="posting-hint" class="hint">
          The posting is treated as data, never as instructions. {{ posting.length.toLocaleString('en') }} / {{ MAX.toLocaleString('en') }}
        </span>
      </div>
      <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
      <MasterImport v-if="needsMaster" />
    </form>

    <details class="manual">
      <summary>Add an application I sent elsewhere</summary>
      <form class="milestone-form" @submit.prevent="addManual">
        <label>Company <input v-model="manual.company" type="text" required maxlength="200" /></label>
        <label>Role <input v-model="manual.role_title" type="text" required maxlength="200" /></label>
        <label>Applied on <input v-model="manual.applied_on" type="date" required /></label>
        <div class="row">
          <button type="submit" :disabled="busy || !manual.company.trim() || !manual.role_title.trim() || !manual.applied_on">Add application</button>
        </div>
        <p v-if="manualError" class="notice danger" role="alert">{{ manualError }}</p>
      </form>
    </details>

    <h2>Your applications</h2>
    <p v-if="loaded && !career.list.length" class="placeholder">
      None yet. Paste a posting above and the app drafts a CV and cover letter from your master CV, with a source for every line.
    </p>
    <table v-else-if="career.list.length" class="ledger">
      <thead>
        <tr>
          <th scope="col">Role</th><th scope="col">Company</th><th scope="col">Status</th><th scope="col">Latest</th>
          <th scope="col" class="num">Interview</th><th scope="col" class="num">Follow up</th><th scope="col" class="num">Updated</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="a in career.list" :key="a.id">
          <td>
            <RouterLink :to="`/applications/${a.id}`">{{ a.role_title ?? `Application ${a.id}` }}</RouterLink>
          </td>
          <td>{{ a.company ?? '—' }}</td>
          <td><span class="status" :class="statusLabel(a).tone">{{ statusLabel(a).text }}</span></td>
          <td>
            <template v-if="a.last_milestone">{{ MILESTONE_TEXT[a.last_milestone] }}, <time :datetime="a.last_milestone_on!">{{ dayText(a.last_milestone_on!) }}</time></template>
          </td>
          <td class="num"><time v-if="a.next_interview" :datetime="a.next_interview">{{ dayText(a.next_interview) }}</time></td>
          <td class="num"><time v-if="a.follow_up_on" :datetime="a.follow_up_on">{{ dayText(a.follow_up_on) }}</time></td>
          <td class="num"><time :datetime="a.updated_at">{{ date(a.updated_at) }}</time></td>
        </tr>
      </tbody>
    </table>
  </main>
</template>
