<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { getCategoryMails, gmailLink, removeMailCategory, renameMailCategory, saveIdea, sortMail } from '../api';
import type { MailCategory, MailRow } from '../api';
import { mailDay, paragraphMeta, plural } from '../mail';

// One category: its paragraph first (what the mail gave you), then its mail with a Move on each.
const props = defineProps<{ category: MailCategory; categories: MailCategory[]; consent: boolean; version: number; busy: boolean; run: (job: () => Promise<string | void>, failure: string) => Promise<void> }>();
const emit = defineEmits<{ removed: [] }>();

const mails = ref<MailRow[] | null>(null);
const failed = ref(false);
const renaming = ref(false);
const renameTo = ref('');
const confirmRemove = ref(false);

async function load() {
  try {
    mails.value = (await getCategoryMails(props.category.id)).mails;
    failed.value = false;
  } catch {
    failed.value = true;
  }
}

const nameOf = (id: number) => props.categories.find((c) => c.id === id)?.name ?? 'that category';
const move = (m: MailRow, to: number) => props.run(async () => {
  await sortMail(m.id, to);
  return `Moved to ${nameOf(to)}.`;
}, 'Could not move that mail. Try again.');
const rename = () => props.run(async () => {
  await renameMailCategory(props.category.id, renameTo.value.trim());
  renaming.value = false;
}, 'Could not rename it. The name may be taken.');
const remove = () => props.run(async () => {
  await removeMailCategory(props.category.id);
  emit('removed');
  return `${props.category.name} removed; its mail went to Needs sorting.`;
}, 'Could not remove that category.');
const save = () => props.run(async () => {
  const { saved, path } = await saveIdea(props.category.id);
  return saved ? `Saved to ${path} in your vault.` : `Already saved as ${path}.`;
}, 'Could not save the idea. Try again.');

onMounted(load);
watch(() => props.version, load);
watch(() => props.category.id, () => {
  mails.value = null;
  renaming.value = confirmRemove.value = false;
  void load();
});
</script>

<template>
  <header class="view-head">
    <div v-if="!renaming" class="title-row">
      <h2 id="view-title" tabindex="-1">{{ category.name }}</h2>
      <div class="row">
        <button type="button" class="quiet" @click="(renaming = true), (renameTo = category.name)">Rename</button>
        <template v-if="!category.system">
          <template v-if="confirmRemove">
            <span class="hint">Its mail goes back to Needs sorting.</span>
            <button type="button" class="quiet danger" :disabled="busy" @click="remove">Remove</button>
            <button type="button" class="quiet" @click="confirmRemove = false">Keep</button>
          </template>
          <button v-else type="button" class="quiet" @click="confirmRemove = true">Remove</button>
        </template>
      </div>
    </div>
    <form v-else class="row rename" @submit.prevent="rename">
      <label class="sr-only" for="rename-category">New name for {{ category.name }}</label>
      <input id="rename-category" v-model="renameTo" type="text" maxlength="60" />
      <button type="submit" :disabled="busy || !renameTo.trim()">Save</button>
      <button type="button" class="quiet" @click="renaming = false">Cancel</button>
    </form>
    <p class="hint">
      {{ plural(category.count, 'mail') }}
      <template v-if="category.system === 'personal'"> · kept as dates only: no sender, subject or text</template>
      <template v-else-if="category.system === 'noise'"> · kept as senders only, never sent to Claude</template>
    </p>
  </header>

  <section v-if="!category.system" class="paragraph" aria-labelledby="idea-title">
    <h3 id="idea-title" class="sr-only">This week's idea</h3>
    <template v-if="category.paragraph">
      <p class="reading">{{ category.paragraph.text }}</p>
      <div class="spread">
        <p class="hint">
          {{ paragraphMeta(category.paragraph) }}<template v-if="category.refreshing"> · refreshing</template><template v-if="category.paragraph.refresh_failed"> · the last refresh failed</template><template v-if="category.paragraph.source_removed"> · a source was removed</template>
        </p>
        <button type="button" :disabled="busy" @click="save">Save idea</button>
      </div>
    </template>
    <p v-else class="hint">{{ category.refreshing ? 'Writing this week’s paragraph…' : consent ? 'No paragraph yet: there is no new mail here from the last 7 days.' : 'No paragraph: Claude analysis is off.' }}</p>
  </section>

  <p v-if="failed" class="notice danger" role="alert">Could not load this category's mail. <button type="button" @click="load">Try again</button></p>
  <p v-else-if="!mails" class="placeholder" role="status">Loading…</p>
  <p v-else-if="!mails.length" class="hint">No mail here yet.</p>
  <table v-else class="mail-table">
    <caption class="sr-only">Mail in {{ category.name }}, newest first</caption>
    <thead>
      <tr>
        <th scope="col">Mail</th>
        <th scope="col" class="when">Date</th>
        <th scope="col" class="move">Move to</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="m in mails" :key="m.id">
        <td class="mail">
          <a :href="gmailLink(m)" target="_blank" rel="noopener noreferrer" :title="m.subject ?? ''">{{ m.subject || (category.system === 'personal' ? `Personal mail of ${mailDay(m.internal_date)}` : category.system === 'noise' ? m.sender : '(no subject)') }}</a>
          <span v-if="m.sender && category.system !== 'noise'" class="from" :title="m.sender">{{ m.sender }}</span>
        </td>
        <td class="when">{{ mailDay(m.internal_date) }}</td>
        <td class="move">
          <label class="sr-only" :for="`move-${m.id}`">Move {{ m.subject || 'this mail' }} to</label>
          <select :id="`move-${m.id}`" :disabled="busy" :value="category.id" @change="move(m, Number(($event.target as HTMLSelectElement).value))">
            <option v-for="o in categories" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select>
        </td>
      </tr>
    </tbody>
  </table>
  <p v-if="mails && mails.length >= 100" class="hint">Showing the newest 100. Older mail is in Gmail.</p>
</template>

<style scoped>
.title-row { display: flex; gap: var(--s3); align-items: baseline; justify-content: space-between; flex-wrap: wrap; }
.rename { margin-bottom: var(--s2); }
.rename input { max-width: 20rem; }
.paragraph { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s5); margin: 0 0 var(--s6); }
.reading { font-family: var(--serif); font-size: 19px; line-height: 30px; max-width: var(--measure); margin: 0 0 var(--s3); font-optical-sizing: auto; }
.paragraph .hint { margin: 0; }
.mail-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.mail-table th { text-align: left; font-size: 13px; line-height: 18px; font-weight: 600; color: var(--muted); padding: 0 0 var(--s2); border-bottom: 1px solid var(--border-strong); }
.mail-table td { padding: var(--s2) 0; border-bottom: 1px solid var(--border); vertical-align: middle; }
.mail { min-width: 0; padding-right: var(--s3); }
.mail a, .from { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mail a { color: var(--fg); text-decoration: none; }
.mail a:hover { text-decoration: underline; }
.from { font-size: 13px; color: var(--muted); }
.when { width: 6.5rem; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.move { width: 12rem; }
/* Quiet until used: a table of bordered boxes would out-shout the mail itself. */
.move select { width: 100%; min-height: 32px; padding-block: 4px; background-color: transparent; border-color: transparent; color: var(--muted); cursor: pointer; }
.move select:hover, .move select:focus { border-color: var(--border-strong); color: var(--fg); background-color: var(--field); }
@media (max-width: 720px) {
  .when { display: none; }
  .move { width: 9rem; }
}
</style>
