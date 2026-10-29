<script setup lang="ts">
import { ref } from 'vue';
import { ApiError, importMaster } from '../api';

const emit = defineEmits<{ done: [] }>();
const busy = ref(false);
const result = ref<{ ok: boolean; text: string; warnings: string[] } | null>(null);

const ERRORS: Record<string, string> = {
  master_exists: 'You already have a master CV. Edit it on the Master CV page.',
  import_empty: 'No usable file in career/import/ in your data folder. Put your CV or LinkedIn export there.',
  import_unreadable: 'The files in career/import/ gave no text.',
  contact_missing: 'Fill in at least your name in career/contact.md first, so it can be kept away from the model.',
  provider_not_configured: 'Connect a provider first (see the banner at the top).',
  provider_error: 'The model provider returned an error. Try again.',
};

async function run() {
  busy.value = true;
  result.value = null;
  try {
    const { warnings } = await importMaster();
    result.value = { ok: true, text: 'Import proposed. Approve it in Review to create career/master.md.', warnings };
    emit('done');
  } catch (err) {
    const e = err instanceof ApiError ? err : null;
    result.value = { ok: false, text: (e?.detail && ERRORS[e.detail]) || "The import didn't work.", warnings: e?.warnings ?? [] };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="master-import">
    <button type="button" :disabled="busy" @click="run">{{ busy ? 'Importing…' : 'Import master CV' }}</button>
    <span class="hint">Reads your CV or LinkedIn export from <code>career/import/</code> in the data folder.</span>
    <div v-if="result" :role="result.ok ? 'status' : 'alert'" class="notice" :class="result.ok ? 'ok' : 'danger'">
      <p>{{ result.text }}</p>
      <template v-if="result.warnings.length">
        <p class="hint">Notes on the files:</p>
        <ul>
          <li v-for="(w, i) in result.warnings" :key="i">{{ w }}</li>
        </ul>
      </template>
    </div>
  </div>
</template>
