<script setup lang="ts">
import { computed } from 'vue';
import type { MailAccounts, MailOverview } from '../api';
import { ago } from '../mail';

// Home's Email area, in the same shape as Career and Master CV: one figure for what needs you, one line for the rest.
const props = defineProps<{ accounts: MailAccounts | null; overview: MailOverview | null; failed: boolean }>();

const live = computed(() => props.accounts?.accounts.filter((a) => a.status !== 'disconnected') ?? []);
const problem = computed(() => {
  if (live.value.some((a) => a.status === 'reconnect')) return 'An account needs reconnecting';
  if (live.value.some((a) => a.triage_error)) return 'Sorting is paused';
  return '';
});
const line = computed(() => {
  const o = props.overview;
  if (!o) return '';
  const synced = live.value.map((a) => a.last_synced_at).filter((s): s is string => !!s).sort().at(-1);
  const parts = [synced ? `Synced ${ago(synced)}` : 'First sync running'];
  if (o.calibration.calibrating) parts.push(`sorting ${o.calibration.done} of ${o.calibration.total}`);
  parts.push(`Claude analysis ${o.consent ? 'on' : 'off'}`);
  return parts.join(' · ');
});
</script>

<template>
  <RouterLink to="/email" class="area" :class="{ off: !live.length }">
    <h2>Email</h2>
    <template v-if="failed">
      <p class="big"><span>Can't be read</span></p>
      <p class="hint">The mail summary didn't load. Open Email to see why.</p>
    </template>
    <template v-else-if="accounts && !live.length">
      <p class="big"><span>Not connected</span></p>
      <p class="hint">Connect Gmail to sort your mail into ideas.</p>
    </template>
    <template v-else-if="overview">
      <p class="big">{{ overview.needs_sorting.toLocaleString() }} <span>to sort</span></p>
      <p v-if="problem" class="problem">{{ problem }}</p>
      <p class="hint">{{ line }}</p>
    </template>
    <p v-else class="hint" role="status">Loading…</p>
  </RouterLink>
</template>

<style scoped>
.problem { margin: 0 0 var(--s1); font-size: 13px; line-height: 19px; font-weight: 600; }
.problem::before { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--danger); margin-right: 6px; vertical-align: 1px; }
.hint { margin: 0; }
.big span { white-space: nowrap; }
</style>
