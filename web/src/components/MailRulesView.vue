<script setup lang="ts">
import { computed } from 'vue';
import { deleteSenderRule } from '../api';
import type { MailCategory, MailOverview } from '../api';
import { plural } from '../mail';

// Every rule in one table: who, where it files, whose rule it is.
const props = defineProps<{ rules: MailOverview['rules']; categories: MailCategory[]; busy: boolean; run: (job: () => Promise<string | void>, failure: string) => Promise<void> }>();

const nameOf = (id: number) => props.categories.find((c) => c.id === id)?.name ?? 'Unknown';
const learned = computed(() => props.rules.filter((r) => r.learned).length);
const label = (sender: string) => (sender.startsWith('#') ? 'Personal sender (address hidden)' : sender);
const stop = (sender: string, isLearned: boolean) =>
  props.run(async () => {
    await deleteSenderRule(sender);
    return isLearned ? 'Rule stopped. It won’t be learned again.' : 'Rule removed.';
  }, 'Could not change that rule.');
</script>

<template>
  <header class="view-head">
    <h2 id="view-title" tabindex="-1">Sender rules</h2>
    <p class="hint">{{ rules.length ? `${plural(rules.length, 'rule')}: ${learned} learned from your sorting, ${rules.length - learned} your own.` : 'No rules yet.' }}</p>
  </header>
  <div v-if="!rules.length" class="empty">
    <p>Rules appear as you sort.</p>
    <p class="hint">A sender you file the same way 3 times gets one, and "Always" makes one at once. Mail from a Personal or Noise sender is then filed from its headers alone: its text is never fetched.</p>
  </div>
  <table v-else class="rules">
    <caption class="sr-only">Sender rules</caption>
    <thead>
      <tr>
        <th scope="col">Sender</th>
        <th scope="col" class="to">Files to</th>
        <th scope="col" class="kind">Made by</th>
        <th scope="col" class="act"><span class="sr-only">Action</span></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="r in rules" :key="r.sender">
        <td class="sender" :title="label(r.sender)">{{ label(r.sender) }}</td>
        <td class="to">{{ nameOf(r.category_id) }}</td>
        <td class="kind">{{ r.learned ? 'Learned' : 'You' }}</td>
        <td class="act">
          <button type="button" class="quiet" :disabled="busy" :aria-label="`${r.learned ? 'Stop' : 'Remove'} the rule for ${label(r.sender)}`" @click="stop(r.sender, !!r.learned)">{{ r.learned ? 'Stop' : 'Remove' }}</button>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.rules { width: 100%; border-collapse: collapse; table-layout: fixed; }
.rules th { text-align: left; font-size: 13px; line-height: 18px; font-weight: 600; color: var(--muted); padding: 0 0 var(--s2); border-bottom: 1px solid var(--border-strong); }
.rules td { padding: var(--s2) 0; border-bottom: 1px solid var(--border); }
.sender { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: var(--s3); }
.to { width: 11rem; }
.kind { width: 6rem; color: var(--muted); }
.act { width: 5.5rem; text-align: right; }
.empty p { margin-bottom: var(--s1); }
@media (max-width: 720px) {
  .kind { display: none; }
  .to { width: 8rem; }
}
</style>
