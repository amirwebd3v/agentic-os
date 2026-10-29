<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError, createApplication, createManualApplication } from '../api';
import { today } from '../stores/career';

const MAX = 30_000; // contract §8.2
const router = useRouter();
const mode = ref<'tailor' | 'manual'>('tailor');
const posting = ref('');
const about = ref({ company_name: '', company_website: '', research: '', target_country: '' });
const RESEARCH_MAX = 20_000;
const box = ref<HTMLTextAreaElement>();
const busy = ref(false);
const error = ref<string | null>(null);
const needsMaster = ref(false);

const ERRORS: Record<string, string> = {
  master_missing: 'There is no master CV yet. Add it on the Master CV page, then paste the posting again.',
  provider_not_configured: 'Connect a provider first (see the banner at the top).',
  posting_too_long: `The posting is longer than ${MAX.toLocaleString('en')} characters. Paste only the job description.`,
  research_too_long: `Your company notes are longer than ${RESEARCH_MAX.toLocaleString('en')} characters. Keep the parts that matter.`,
};

async function start() {
  busy.value = true;
  error.value = null;
  try {
    const extra = Object.fromEntries(Object.entries(about.value).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    const { id } = await createApplication({ posting: posting.value, ...extra });
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
async function addManual() {
  busy.value = true;
  error.value = null;
  try {
    const { id } = await createManualApplication(manual.value);
    await router.push(`/applications/${id}`);
  } catch (err) {
    error.value = err instanceof ApiError && err.detail === 'bad_date' ? 'That is not a valid date.' : "Couldn't add it. Is the server running?";
  } finally {
    busy.value = false;
  }
}

onMounted(() => box.value?.focus());
</script>

<template>
  <main class="page">
    <header class="page-head">
      <h1>New application</h1>
      <p class="lede">Paste a job posting and the app drafts a CV and a cover letter from your master CV, with a source for every line. Nothing is sent.</p>
    </header>

    <div class="seg" role="group" aria-label="How you applied">
      <button type="button" :aria-pressed="mode === 'tailor'" @click="mode = 'tailor'">Tailor for a posting</button>
      <button type="button" :aria-pressed="mode === 'manual'" @click="mode = 'manual'">I applied elsewhere</button>
    </div>
    <p v-if="error" class="notice danger" role="alert">
      {{ error }} <RouterLink v-if="needsMaster" to="/cv">Open Master CV</RouterLink>
    </p>

    <div v-if="mode === 'tailor'" class="composer">
      <form @submit.prevent="start" @keydown.ctrl.enter.prevent="start" @keydown.meta.enter.prevent="start">
        <label for="posting" class="label">The job posting</label>
        <textarea
          id="posting" ref="box" v-model="posting" :maxlength="MAX" aria-describedby="posting-hint"
          placeholder="Paste the whole posting: title, company, what they ask for…"
        ></textarea>
        <fieldset class="about">
          <legend class="label">The company, for the cover letter (optional)</legend>
          <div class="pair">
            <label>Company name <input v-model="about.company_name" type="text" maxlength="200" /></label>
            <label>Website <input v-model="about.company_website" type="text" maxlength="500" placeholder="Not visited, kept as a note" /></label>
          </div>
          <label>Target country <input v-model="about.target_country" type="text" maxlength="100" placeholder="e.g. Germany" /></label>
          <label>Your research on the company
            <textarea v-model="about.research" rows="6" :maxlength="RESEARCH_MAX" aria-describedby="research-hint" placeholder="Paste what you know: products, customers, competitors, recent news, challenges…"></textarea>
          </label>
          <span id="research-hint" class="hint">The letter agent uses only this and the posting, marks every point as verified (quoted) or an assumption, and never searches the web.</span>
        </fieldset>
        <div class="spread">
          <button type="submit" class="primary" :disabled="busy || !posting.trim()">{{ busy ? 'Starting…' : 'Tailor CV and letter' }}</button>
          <span id="posting-hint" class="hint">{{ posting.length.toLocaleString('en') }} / {{ MAX.toLocaleString('en') }} · <kbd>Ctrl</kbd> <kbd>Enter</kbd> starts</span>
        </div>
      </form>
      <aside>
        <h2>What happens next</h2>
        <ol>
          <li>The app reads the posting and lists what it asks for.</li>
          <li>It picks the matching lines of your master CV.</li>
          <li>It finds gaps against the posting, writes the CV, checks every line against its source and scores it like an ATS.</li>
          <li>It studies the company from your notes and works out what the role is for.</li>
          <li>If evidence is missing, it stops and asks you. Then it writes the cover letter.</li>
        </ol>
        <p>It takes a few minutes; you can leave the page. The posting is treated as data, never as instructions to the model.</p>
      </aside>
    </div>

    <form v-else class="milestone-form narrow" @submit.prevent="addManual">
      <label class="wide">Company <input v-model="manual.company" type="text" required maxlength="200" /></label>
      <label class="wide">Role <input v-model="manual.role_title" type="text" required maxlength="200" /></label>
      <label>Applied on <input v-model="manual.applied_on" type="date" required /></label>
      <div class="row wide">
        <button type="submit" class="primary" :disabled="busy || !manual.company.trim() || !manual.role_title.trim() || !manual.applied_on">Add application</button>
        <span class="hint">Tracked here with its timeline; there is no draft.</span>
      </div>
    </form>
  </main>
</template>
