<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getMailAccounts, getMailOverview, saveIdea } from '../api';
import type { MailAccounts, MailCategory, MailOverview } from '../api';

// Home's Email area (D6): each category's status and its one paragraph, nothing more. Paragraphs are model text from
// mail: rendered with {{ }} only.
const accounts = ref<MailAccounts>();
const overview = ref<MailOverview>();
const failed = ref(false);
const saved = ref<Record<number, string>>({});
const saving = ref<number | null>(null);

const connected = computed(() => accounts.value?.accounts.filter((a) => a.status !== 'disconnected') ?? []);
const needsReconnect = computed(() => connected.value.some((a) => a.status === 'reconnect'));
const down = computed(() => connected.value.some((a) => a.triage_error === 'classifier_down'));
const ideas = computed(() => overview.value?.categories.filter((c) => c.system === null) ?? []);
const quiet = computed(() => overview.value?.categories.filter((c) => c.system !== null) ?? []);
const age = (iso: string) => {
  const h = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  return h < 1 ? 'just now' : h < 48 ? `${h}h old` : `${Math.round(h / 24)} days old`;
};

async function save(c: MailCategory) {
  saving.value = c.id;
  try {
    const { saved: isNew, path } = await saveIdea(c.id);
    saved.value[c.id] = isNew ? `Saved to ${path}` : 'Already saved';
  } catch {
    saved.value[c.id] = 'Could not save. Try again.';
  } finally {
    saving.value = null;
  }
}

onMounted(async () => {
  try {
    accounts.value = await getMailAccounts();
    if (accounts.value.accounts.some((a) => a.status !== 'disconnected')) overview.value = await getMailOverview();
  } catch {
    failed.value = true;
  }
});
</script>

<template>
  <section class="email-card" aria-labelledby="email-title">
    <header class="spread">
      <h2 id="email-title">Email</h2>
      <RouterLink to="/email">Open Email</RouterLink>
    </header>
    <p v-if="failed" class="hint">Couldn't load your mail.</p>
    <p v-else-if="accounts && !connected.length" class="hint">Not connected. <RouterLink to="/email">Connect Gmail</RouterLink> to sort your mail into ideas.</p>
    <template v-else-if="overview">
      <p v-if="needsReconnect" class="notice attention"><strong>An account needs reconnecting.</strong> <RouterLink to="/email">Reconnect it</RouterLink>.</p>
      <p v-if="down" class="notice attention"><strong>The classifier is down.</strong> Sorting is paused, and nothing goes to Claude instead.</p>
      <p v-if="overview.calibration.calibrating" class="hint">Sorting {{ overview.calibration.done }} of {{ overview.calibration.total }}. You check these yourself before anything is filed automatically.</p>
      <p v-if="overview.needs_sorting"><RouterLink to="/email">{{ overview.needs_sorting }} {{ overview.needs_sorting === 1 ? 'mail needs' : 'mails need' }} sorting</RouterLink></p>
      <ul class="cats">
        <li v-for="c in ideas" :key="c.id">
          <div class="spread">
            <strong>{{ c.name }}</strong>
            <span class="hint">{{ c.count }} {{ c.count === 1 ? 'mail' : 'mails' }}</span>
          </div>
          <template v-if="c.paragraph">
            <p class="para">{{ c.paragraph.text }}</p>
            <div class="spread">
              <span class="hint">{{ age(c.paragraph.created_at) }}<template v-if="c.paragraph.cost_usd !== null"> · ${{ c.paragraph.cost_usd.toFixed(3) }}</template><template v-if="c.paragraph.refresh_failed"> · couldn't refresh</template><template v-if="c.paragraph.source_removed"> · a source was removed</template></span>
              <span class="row">
                <span v-if="saved[c.id]" class="hint" role="status">{{ saved[c.id] }}</span>
                <button type="button" class="quiet" :disabled="saving === c.id" @click="save(c)">Save idea</button>
              </span>
            </div>
          </template>
          <p v-else class="hint">{{ c.refreshing ? 'Writing a paragraph…' : overview.consent ? 'Nothing new.' : 'No paragraph: Claude analysis is off.' }}</p>
        </li>
      </ul>
      <p class="hint">{{ quiet.map((c) => `${c.name}: ${c.count}`).join(' · ') }}</p>
    </template>
  </section>
</template>

<style scoped>
.email-card { margin: var(--s6) 0; }
.cats { list-style: none; padding: 0; margin: var(--s3) 0; }
.cats > li { border-top: 1px solid var(--border); padding: var(--s3) 0; }
.para { max-width: var(--measure); margin: var(--s2) 0; }
.hint { color: var(--muted); font-size: 13px; }
</style>
