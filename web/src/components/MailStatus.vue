<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { MailAccount, MailOverview } from '../api';
import { accountState, plural } from '../mail';

// The right rail: is everything working, and the few switches that change how mail is handled.
const props = defineProps<{ accounts: MailAccount[]; overview: MailOverview | null; busy: boolean; waiting: boolean }>();
const emit = defineEmits<{
  connect: [];
  disconnect: [account: MailAccount, keep: boolean];
  consent: [on: boolean];
  refresh: [];
  clear: [];
  rules: [];
}>();

const confirming = ref<number | null>(null);
// Asking to confirm swaps the Disconnect button out: focus goes to the safe choice, and back on Cancel.
async function confirm(id: number | null) {
  const from = confirming.value;
  confirming.value = id;
  await nextTick();
  document.getElementById(id === null ? `disconnect-${from}` : `cancel-${id}`)?.focus();
}
const learned = computed(() => props.overview?.rules.filter((r) => r.learned).length ?? 0);
const own = computed(() => (props.overview?.rules.length ?? 0) - learned.value);
const hasParagraphs = computed(() => props.overview?.categories.some((c) => c.paragraph) ?? false);
</script>

<template>
  <aside class="rail" aria-label="Status and settings">
    <section aria-labelledby="rail-accounts">
      <h2 id="rail-accounts">Accounts</h2>
      <ul class="plain">
        <li v-for="a in accounts" :key="a.id" class="account">
          <p class="who" :title="a.email">{{ a.email }}</p>
          <p><span class="status" :class="accountState(a).tone">{{ accountState(a).word }}</span></p>
          <p class="hint">{{ accountState(a).detail }}</p>
          <div class="row">
            <button v-if="a.status !== 'connected'" type="button" class="quiet" :disabled="busy || waiting" @click="emit('connect')">Reconnect</button>
            <template v-if="a.status !== 'disconnected' && confirming === a.id">
              <button type="button" class="quiet" :disabled="busy" @click="emit('disconnect', a, true), (confirming = null)">Disconnect, keep its mail</button>
              <button type="button" class="quiet danger" :disabled="busy" @click="emit('disconnect', a, false), (confirming = null)">Disconnect, delete its mail</button>
              <button :id="`cancel-${a.id}`" type="button" class="quiet" @click="confirm(null)">Cancel</button>
            </template>
            <button v-else-if="a.status !== 'disconnected'" :id="`disconnect-${a.id}`" type="button" class="quiet" :disabled="busy" @click="confirm(a.id)">Disconnect</button>
            <button v-else type="button" class="quiet danger" :disabled="busy" @click="emit('disconnect', a, false)">Delete its mail</button>
          </div>
        </li>
      </ul>
      <button type="button" class="quiet" :disabled="busy || waiting" @click="emit('connect')">{{ waiting ? 'Waiting for Google…' : 'Add a Gmail account' }}</button>
    </section>

    <section v-if="overview" aria-labelledby="rail-claude">
      <h2 id="rail-claude">Claude analysis</h2>
      <p><span class="status" :class="overview.consent ? (overview.provider_ok === false ? 'attention' : 'ready') : ''">{{ overview.consent ? (overview.provider_ok === false ? 'On, but blocked' : 'On') : 'Off' }}</span></p>
      <p v-if="!overview.consent" class="hint">Nothing from your mail goes to Claude. Mail your rules don't cover waits for you.</p>
      <p v-else-if="overview.provider_ok === false" class="hint">The configured provider isn't one mail may go to (this machine or Anthropic, Claude models only), so no call is made.</p>
      <p v-else class="hint">Newsletters that pass every check are sorted by Claude, and each idea category gets a paragraph. Only sender, subject and a redacted excerpt are sent.</p>
      <div class="row">
        <button type="button" :class="overview.consent ? 'quiet' : ''" :disabled="busy" @click="emit('consent', !overview.consent)">{{ overview.consent ? 'Turn off' : 'Allow Claude analysis' }}</button>
        <button v-if="overview.consent" type="button" class="quiet" :disabled="busy" @click="emit('refresh')">Refresh paragraphs</button>
        <button v-if="hasParagraphs" type="button" class="quiet" :disabled="busy" @click="emit('clear')">Clear paragraphs</button>
      </div>
    </section>

    <section v-if="overview" aria-labelledby="rail-learning">
      <h2 id="rail-learning">Learning</h2>
      <dl class="facts">
        <div>
          <dt>Sorted by you</dt>
          <dd>{{ overview.calibration.done.toLocaleString() }}</dd>
        </div>
        <div>
          <dt>Rules learned</dt>
          <dd>{{ learned.toLocaleString() }}</dd>
        </div>
        <div>
          <dt>Your own rules</dt>
          <dd>{{ own.toLocaleString() }}</dd>
        </div>
      </dl>
      <p class="hint">
        <template v-if="overview.calibration.calibrating">Sort {{ plural(overview.calibration.total - overview.calibration.done, 'more mail') }} before anything is filed automatically. </template>
        A sender you sort the same way 3 times gets a rule; Personal and Noise senders are then filed from their headers alone.
      </p>
      <button type="button" class="quiet" @click="emit('rules')">See sender rules</button>
    </section>
  </aside>
</template>

<style scoped>
.rail { display: grid; gap: var(--s6); align-content: start; }
.rail h2 { font-family: var(--sans); font-size: 13px; line-height: 18px; font-weight: 600; color: var(--muted); letter-spacing: 0; margin: 0 0 var(--s3); }
.rail p { margin: 0 0 var(--s1); }
.plain { list-style: none; margin: 0 0 var(--s2); padding: 0; }
.account { padding: 0 0 var(--s4); margin-bottom: var(--s4); border-bottom: 1px solid var(--border); }
.who { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account .row { margin-top: var(--s2); gap: var(--s1); }
.facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s3); margin: 0 0 var(--s3); }
.facts div { display: flex; flex-direction: column-reverse; justify-content: flex-end; }
.facts dt { font-size: 13px; line-height: 18px; color: var(--muted); }
.facts dd { margin: 0; text-align: left; font-family: var(--serif); font-size: 26px; line-height: 32px; font-variant-numeric: tabular-nums; }
/* Text buttons in the rail sit on the text's own left edge, spaced by a gap rather than their padding. */
.rail .quiet { padding-inline: 0; }
.rail .row { gap: var(--s1) var(--s4); }
</style>
