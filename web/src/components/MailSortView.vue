<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { getNeedsSorting, gmailLink, sortMail } from '../api';
import type { MailCategory, MailRow, SenderGroup } from '../api';
import { mailDay, plural } from '../mail';

// Needs sorting, grouped by sender: the screen's main job. Sender and subject are a stranger's text: {{ }} only.
const props = defineProps<{ categories: MailCategory[]; total: number; version: number; busy: boolean; run: (job: () => Promise<string | void>, failure: string) => Promise<void> }>();

const PREVIEW = 3;
const groups = ref<SenderGroup[] | null>(null);
const failed = ref(false);
const choice = ref<Record<string, number | undefined>>({});
const expanded = ref<Set<string>>(new Set());

const key = (g: SenderGroup) => g.sender ?? '';
const picked = (g: SenderGroup) => choice.value[key(g)] ?? g.suggestion_id ?? undefined;
const nameOf = (id: number) => props.categories.find((c) => c.id === id)?.name ?? 'that category';
const shown = (g: SenderGroup) => (expanded.value.has(key(g)) ? g.mails : g.mails.slice(0, PREVIEW));

async function load() {
  try {
    groups.value = (await getNeedsSorting()).groups;
    failed.value = false;
  } catch {
    failed.value = true;
  }
}

const sortAll = (mails: MailRow[], category: number) =>
  props.run(async () => {
    for (const m of mails) await sortMail(m.id, category);
    return `${plural(mails.length, 'mail')} filed in ${nameOf(category)}.`;
  }, 'Could not sort that mail. Try again.');

const always = (g: SenderGroup, category: number) =>
  props.run(async () => {
    const { moved } = await sortMail(g.mails[0]!.id, category, { always: true, apply_stored: true });
    return `Mail from ${g.sender} now goes to ${nameOf(category)}. ${plural(moved, 'mail')} moved.`;
  }, 'Could not save that rule. Try again.');

function toggle(g: SenderGroup) {
  const next = new Set(expanded.value);
  if (next.has(key(g))) next.delete(key(g));
  else next.add(key(g));
  expanded.value = next;
}

onMounted(load);
watch(() => props.version, load);
</script>

<template>
  <header class="view-head">
    <h2 id="view-title" tabindex="-1">Needs sorting</h2>
    <p class="hint">{{ total ? `${plural(total, 'mail')} from ${plural(groups?.length ?? 0, 'sender')}. Pick a category; "Always" also makes a rule.` : 'Everything is filed.' }}</p>
  </header>

  <p v-if="failed" class="notice danger" role="alert">Could not load the mail to sort. <button type="button" @click="load">Try again</button></p>
  <p v-else-if="!groups" class="placeholder" role="status">Loading…</p>
  <div v-else-if="!groups.length" class="empty">
    <p>Nothing is waiting for you.</p>
    <p class="hint">New mail your rules and Claude can't place lands here. Each sort teaches a rule after 3 mails from the same sender.</p>
  </div>

  <ul v-else class="groups">
    <li v-for="(g, gi) in groups" :key="key(g)" class="group">
      <div class="group-head">
        <div class="sender">
          <p class="who" :title="g.sender ?? ''">{{ g.sender ?? 'Mail that could not be read' }}</p>
          <p class="hint">{{ plural(g.mails.length, 'mail') }} · newest {{ mailDay(g.mails[0]!.internal_date) }}<template v-if="g.suggestion_id"> · suggested: {{ nameOf(g.suggestion_id) }}</template></p>
        </div>
        <div class="controls">
          <label class="sr-only" :for="`pick-${gi}`">Category for {{ g.sender ?? 'unread mail' }}</label>
          <select :id="`pick-${gi}`" :value="picked(g) ?? ''" @change="choice[key(g)] = Number(($event.target as HTMLSelectElement).value)">
            <option value="" disabled>Choose a category</option>
            <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button type="button" :disabled="busy || !picked(g)" @click="sortAll(g.mails, picked(g)!)">{{ g.mails.length === 1 ? 'File it' : `File all ${g.mails.length}` }}</button>
          <button v-if="g.sender" type="button" class="quiet" :disabled="busy || !picked(g)" @click="always(g, picked(g)!)">Always</button>
        </div>
      </div>
      <ul class="mails">
        <li v-for="m in shown(g)" :key="m.id">
          <a :href="gmailLink(m)" target="_blank" rel="noopener noreferrer" :title="m.subject ?? ''">{{ m.subject || '(no subject)' }}</a>
          <span class="meta">{{ mailDay(m.internal_date) }}</span>
          <button type="button" class="quiet" :disabled="busy || !picked(g)" :aria-label="`File only ${m.subject || 'this mail'}`" @click="sortAll([m], picked(g)!)">Only this</button>
        </li>
      </ul>
      <button v-if="g.mails.length > PREVIEW" type="button" class="quiet more" :aria-expanded="expanded.has(key(g))" @click="toggle(g)">
        {{ expanded.has(key(g)) ? 'Show fewer' : `Show all ${g.mails.length}` }}
      </button>
    </li>
  </ul>
</template>

<style scoped>
.groups, .mails { list-style: none; margin: 0; padding: 0; }
.group { padding: var(--s4) 0; border-top: 1px solid var(--border); }
.group-head { display: flex; gap: var(--s4); align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
.sender { min-width: 0; flex: 1 1 14rem; }
.sender p { margin: 0; }
.who { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.controls { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }
.controls select { min-width: 12rem; }
.mails { margin-top: var(--s2); }
.mails li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: var(--s3); align-items: center; min-height: 32px; }
.mails a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); text-decoration: none; }
.mails a:hover { text-decoration: underline; }
.meta { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.more { padding-left: 0; margin-top: var(--s1); }
.empty p { margin-bottom: var(--s1); }
@media (max-width: 720px) {
  .controls { display: grid; grid-template-columns: 1fr auto; width: 100%; }
  .controls select { grid-column: 1 / -1; min-width: 0; }
}
</style>
