<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { addMailCategory, ApiError, clearParagraphs, deleteSenderRule, getCategoryMails, getMailOverview, getNeedsSorting, gmailLink, refreshParagraphs, removeMailCategory, renameMailCategory, setMailConsent, sortMail } from '../api';
import type { MailOverview, MailParagraph, MailRow, SenderGroup } from '../api';

// Sender and subject are mail text, which a stranger wrote: rendered with {{ }} only. Links come from gmailLink().
const overview = ref<MailOverview>();
const groups = ref<SenderGroup[]>([]);
const open = ref<number | null>(null);
const openMails = ref<MailRow[]>([]);
const choice = ref<Record<string, number | undefined>>({});
const error = ref('');
const notice = ref('');
const busy = ref(false);
const newName = ref('');
const renaming = ref<number | null>(null);
const renameTo = ref('');
const confirmRemove = ref<number | null>(null);

const categories = computed(() => overview.value?.categories ?? []);
const hasParagraphs = computed(() => categories.value.some((c) => c.paragraph));
async function refresh() {
  const { queued } = await refreshParagraphs();
  notice.value = queued ? `Writing ${queued} ${queued === 1 ? 'paragraph' : 'paragraphs'}.` : 'Nothing new since the last paragraphs.';
}
function paragraphMeta(p: MailParagraph): string {
  const hours = Math.round((Date.now() - Date.parse(p.created_at)) / 3_600_000);
  const parts = [hours < 1 ? 'Just now' : hours < 48 ? `${hours}h old` : `${Math.round(hours / 24)} days old`];
  parts.push(`from ${p.cites.length} ${p.cites.length === 1 ? 'mail' : 'mails'}`);
  parts.push(p.cost_usd === null ? 'cost not priced' : `cost $${p.cost_usd.toFixed(3)}`);
  if (p.refresh_failed) parts.push("couldn't refresh");
  if (p.source_removed) parts.push('a source was removed');
  return parts.join(' · ');
}
const nameOf = (id: number) => categories.value.find((c) => c.id === id)?.name ?? 'Unknown';
const senderKey = (g: SenderGroup) => g.sender ?? '';
const picked = (g: SenderGroup) => choice.value[senderKey(g)] ?? g.suggestion_id ?? undefined;
const day = (iso: string) => iso.slice(0, 10);

async function load() {
  error.value = '';
  try {
    const [o, n] = await Promise.all([getMailOverview(), getNeedsSorting()]);
    overview.value = o;
    groups.value = n.groups;
    if (open.value !== null) openMails.value = (await getCategoryMails(open.value)).mails;
  } catch {
    error.value = 'Could not load your mail.';
  }
}

async function act(run: () => Promise<unknown>, failure: string) {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await run();
    await load();
  } catch (err) {
    error.value = err instanceof ApiError && err.detail === 'name_taken' ? 'A category with that name already exists.' : failure;
  } finally {
    busy.value = false;
    // The control that was clicked may be gone after the reload: keep keyboard focus somewhere sensible.
    if (!document.activeElement || document.activeElement === document.body) await nextTick(() => heading.value?.focus());
  }
}
const heading = ref<HTMLElement>();

/** Just these mails. */
const sortMails = (mails: MailRow[], category: number) =>
  act(async () => {
    for (const m of mails) await sortMail(m.id, category);
  }, 'Could not sort that mail. Try again.');

/** The rule covers later mail, and this sender's mail already here. */
const always = (g: SenderGroup, category: number) =>
  act(async () => {
    const { moved } = await sortMail(g.mails[0]!.id, category, { always: true, apply_stored: true });
    notice.value = `Mail from ${g.sender} now goes to ${nameOf(category)}. ${moved} ${moved === 1 ? 'mail' : 'mails'} moved.`;
  }, 'Could not save that rule. Try again.');

async function toggle(id: number) {
  if (open.value === id) {
    open.value = null;
    return;
  }
  open.value = id;
  openMails.value = [];
  await act(async () => {}, '');
}

const add = () =>
  act(async () => {
    await addMailCategory(newName.value);
    newName.value = '';
  }, 'Could not add that category.');
const saveRename = (id: number) =>
  act(async () => {
    await renameMailCategory(id, renameTo.value);
    renaming.value = null;
  }, 'Could not rename that category.');
const remove = (id: number) =>
  act(async () => {
    await removeMailCategory(id);
    confirmRemove.value = null;
    if (open.value === id) open.value = null;
  }, 'Could not remove that category.');

onMounted(load);
defineExpose({ load });
</script>

<template>
  <p v-if="error" class="notice danger" role="alert">{{ error }} <button type="button" @click="load">Try again</button></p>
  <p v-if="notice" class="notice ok" role="status">{{ notice }}</p>

  <template v-if="overview">
    <p v-if="overview.calibration.calibrating" class="notice">
      <strong>Sorting {{ overview.calibration.done }} of {{ overview.calibration.total }}.</strong>
      You check the first {{ overview.calibration.total }} mails yourself. Nothing is filed automatically and nothing goes to Claude until then.
    </p>

    <section class="notice" aria-labelledby="consent-title">
      <h2 id="consent-title">Claude analysis</h2>
      <p v-if="overview.consent">
        <strong>On.</strong> For mail that passes every check (a newsletter or a sender you approved, not sensitive, no secrets), the app sends sender, subject and a short redacted excerpt to Claude: to sort mail Laya is unsure about, and to write one paragraph per idea category.
      </p>
      <p v-else><strong>Off.</strong> Nothing from your mail goes to Claude. Sorting stays on this machine, and unsure mail waits for you.</p>
      <p v-if="overview.consent && overview.provider_ok === false" class="muted">The configured provider isn't one mail may go to (this machine or Anthropic, Claude models only), so no call is made.</p>
      <div class="row">
        <button type="button" :class="overview.consent ? '' : 'primary'" :disabled="busy" @click="act(() => setMailConsent(!overview!.consent), 'Could not change that setting.')">{{ overview.consent ? 'Turn off' : 'Allow Claude analysis' }}</button>
        <button v-if="overview.consent" type="button" :disabled="busy" @click="act(refresh, 'Could not refresh the paragraphs.')">Refresh paragraphs</button>
        <button v-if="hasParagraphs" type="button" class="quiet" :disabled="busy" @click="act(clearParagraphs, 'Could not clear the paragraphs.')">Clear paragraphs</button>
      </div>
    </section>

    <section aria-labelledby="sorting-title">
      <h2 id="sorting-title" ref="heading" tabindex="-1">Needs sorting <span v-if="overview.needs_sorting" class="badge count">{{ overview.needs_sorting }}</span></h2>
      <p v-if="!groups.length" class="muted">Nothing is waiting for you.</p>
      <div v-for="(g, gi) in groups" :key="senderKey(g)" class="group">
        <div class="spread">
          <div>
            <strong v-if="g.sender">{{ g.sender }}</strong>
            <strong v-else>Mail that could not be read</strong>
            <span class="muted"> · {{ g.mails.length }} {{ g.mails.length === 1 ? 'mail' : 'mails' }}</span>
          </div>
          <div class="row">
            <label class="sr-only" :for="`cat-${gi}`">Category for {{ g.sender ?? 'unread mail' }}</label>
            <select :id="`cat-${gi}`" :value="picked(g)" @change="choice[senderKey(g)] = Number(($event.target as HTMLSelectElement).value)">
              <option :value="undefined" disabled>Choose a category</option>
              <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
            <button type="button" :disabled="busy || !picked(g)" @click="sortMails(g.mails, picked(g)!)">Sort {{ g.mails.length === 1 ? 'this mail' : `these ${g.mails.length}` }}</button>
            <button v-if="g.sender" type="button" :disabled="busy || !picked(g)" @click="always(g, picked(g)!)">Always this sender</button>
          </div>
        </div>
        <ul class="mails">
          <li v-for="m in g.mails" :key="m.id" class="spread">
            <a :href="gmailLink(m)" target="_blank" rel="noopener noreferrer">{{ m.subject || '(no subject)' }}</a>
            <span class="row">
              <span class="muted">{{ day(m.internal_date) }} · {{ m.account }}</span>
              <button type="button" class="quiet" :disabled="busy || !picked(g)" @click="sortMails([m], picked(g)!)">Just this mail</button>
            </span>
          </li>
        </ul>
      </div>
    </section>

    <section aria-labelledby="categories-title">
      <h2 id="categories-title">Categories</h2>
      <ul class="categories">
        <li v-for="c in categories" :key="c.id">
          <div class="spread">
            <button v-if="renaming !== c.id" type="button" class="link" :aria-expanded="open === c.id" @click="toggle(c.id)">{{ c.name }} <span class="muted">· {{ c.count }}</span></button>
            <form v-else class="row" @submit.prevent="saveRename(c.id)">
              <label class="sr-only" :for="`rename-${c.id}`">New name</label>
              <input :id="`rename-${c.id}`" v-model="renameTo" type="text" maxlength="60" />
              <button type="submit" :disabled="busy || !renameTo.trim()">Save</button>
              <button type="button" class="quiet" @click="renaming = null">Cancel</button>
            </form>
            <div v-if="renaming !== c.id" class="row">
              <button type="button" class="quiet" @click="(renaming = c.id), (renameTo = c.name)">Rename</button>
              <template v-if="!c.system">
                <template v-if="confirmRemove === c.id">
                  <span class="muted">Its mail moves to Needs sorting.</span>
                  <button type="button" class="danger" :disabled="busy" @click="remove(c.id)">Remove</button>
                  <button type="button" class="quiet" @click="confirmRemove = null">Keep</button>
                </template>
                <button v-else type="button" class="quiet" @click="confirmRemove = c.id">Remove</button>
              </template>
            </div>
          </div>
          <div v-if="c.paragraph" class="paragraph">
            <p>{{ c.paragraph.text }}</p>
            <p class="muted">
              {{ paragraphMeta(c.paragraph) }}<template v-if="c.refreshing"> · refreshing</template>
            </p>
          </div>
          <p v-else-if="c.refreshing" class="muted">Writing a paragraph…</p>
          <template v-if="open === c.id">
            <p v-if="c.system === 'personal'" class="muted">Personal mail keeps no sender or subject here. Move one to read it again.</p>
            <p v-if="!openMails.length" class="muted">Nothing new.</p>
            <ul class="mails">
              <li v-for="m in openMails" :key="m.id" class="spread">
                <span><a :href="gmailLink(m)" target="_blank" rel="noopener noreferrer">{{ m.subject || (c.system === 'personal' ? 'Personal mail' : '(no subject)') }}</a><span v-if="m.sender" class="muted"> · {{ m.sender }}</span></span>
                <span class="row">
                  <span class="muted">{{ day(m.internal_date) }}</span>
                  <label class="sr-only" :for="`move-${m.id}`">Move {{ m.subject || 'this mail' }} to</label>
                  <select :id="`move-${m.id}`" :disabled="busy" :value="c.id" @change="sortMails([m], Number(($event.target as HTMLSelectElement).value))">
                    <option v-for="o in categories" :key="o.id" :value="o.id">{{ o.name }}</option>
                  </select>
                </span>
              </li>
            </ul>
          </template>
        </li>
      </ul>
      <form class="row add" @submit.prevent="add">
        <label for="new-category">New category</label>
        <input id="new-category" v-model="newName" type="text" maxlength="60" />
        <button type="submit" :disabled="busy || !newName.trim()">Add</button>
      </form>
      <p class="muted">A new category applies to mail from now on.</p>
    </section>

    <section v-if="overview.rules.length" aria-labelledby="rules-title">
      <h2 id="rules-title">Sender rules</h2>
      <ul class="categories">
        <li v-for="r in overview.rules" :key="r.sender" class="spread">
          <span>{{ r.sender }} <span class="muted">· {{ nameOf(r.category_id) }}</span></span>
          <button type="button" class="quiet" :disabled="busy" @click="act(() => deleteSenderRule(r.sender), 'Could not remove that rule.')">Remove</button>
        </li>
      </ul>
    </section>
  </template>
</template>

<style scoped>
section { margin-bottom: var(--s6); }
.group { border-top: 1px solid var(--border); padding: var(--s4) 0; }
.mails, .categories { list-style: none; margin: var(--s2) 0 0; padding: 0; }
.mails li { padding: var(--s1) 0; overflow-wrap: anywhere; }
.categories > li { border-top: 1px solid var(--border); padding: var(--s3) 0; }
.mails a { overflow-wrap: anywhere; }
button.link { border: none; background: none; padding: 0; min-height: 28px; color: var(--fg); font-weight: 600; text-align: left; }
button.link:hover:not(:disabled) { color: var(--accent); background: none; }
.add { margin-top: var(--s4); }
.paragraph { margin-top: var(--s2); max-width: var(--measure); }
.paragraph p { margin: 0 0 var(--s1); }
.muted { color: var(--muted); }
</style>
