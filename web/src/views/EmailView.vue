<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { addMailCategory, ApiError, clearParagraphs, connectMailAccount, disconnectMailAccount, getMailAccounts, getMailOverview, refreshParagraphs, setMailConsent } from '../api';
import type { MailAccount, MailAccounts, MailOverview } from '../api';
import MailCategoryView from '../components/MailCategoryView.vue';
import MailRulesView from '../components/MailRulesView.vue';
import MailSortView from '../components/MailSortView.vue';
import MailStatus from '../components/MailStatus.vue';
import { ago, failureText, FLOW_TEXT, plural } from '../mail';

// Three columns: the views (what to look at), the open view (what to do), and the rail (is it all working).
// The open view is in the URL (?view=sort | rules | <category id>), so a reload stays where you were.
const route = useRoute();
const router = useRouter();

const state = ref<MailAccounts>();
const overview = ref<MailOverview | null>(null);
const loadError = ref('');
const notice = ref<{ text: string; tone: 'ok' | 'danger' | '' } | null>(null);
const busy = ref(false);
const version = ref(0);
const newName = ref('');
const adding = ref(false);
let poll: ReturnType<typeof setTimeout> | undefined;
let polling = false;

const live = computed(() => state.value?.accounts.filter((a) => a.status !== 'disconnected') ?? []);
const categories = computed(() => overview.value?.categories ?? []);
const view = computed(() => {
  const v = String(route.query['view'] ?? 'sort');
  if (v === 'rules') return { kind: 'rules' as const };
  const category = categories.value.find((c) => String(c.id) === v);
  return category ? { kind: 'category' as const, category } : { kind: 'sort' as const };
});
const viewKey = computed(() => (view.value.kind === 'category' ? String(view.value.category.id) : view.value.kind));

/** The title row's sentence: what needs you first, then that everything else is fine. */
const status = computed(() => {
  const o = overview.value;
  const parts: { text: string; tone?: 'attention' }[] = [];
  const reconnect = live.value.filter((a) => a.status === 'reconnect').length;
  if (reconnect) parts.push({ text: `${plural(reconnect, 'account needs', 'accounts need')} reconnecting`, tone: 'attention' });
  if (live.value.some((a) => a.triage_error)) parts.push({ text: 'Sorting paused', tone: 'attention' });
  if (o) parts.push({ text: o.needs_sorting ? `${plural(o.needs_sorting, 'mail')} to sort` : 'Nothing to sort' });
  const synced = live.value.map((a) => a.last_synced_at).filter((s): s is string => !!s).sort().at(-1);
  parts.push({ text: synced ? `Synced ${ago(synced)}` : 'First sync running' });
  if (o?.calibration.calibrating) parts.push({ text: `Sorting ${o.calibration.done} of ${o.calibration.total} before automatic filing` });
  if (o) parts.push({ text: `Claude analysis ${o.consent ? 'on' : 'off'}` });
  return parts;
});

function open(v: string) {
  void router.replace({ query: { ...route.query, view: v } });
  void nextTick(() => document.getElementById('view-title')?.focus());
}

async function load() {
  loadError.value = '';
  try {
    const next = await getMailAccounts();
    state.value = next;
    if (next.flow === 'waiting') poll = setTimeout(() => void load(), 2000);
    else if (polling && next.flow === 'failed') notice.value = { text: failureText(next.reason ?? null), tone: 'danger' };
    else if (polling && FLOW_TEXT[next.flow]) notice.value = { text: FLOW_TEXT[next.flow]!, tone: next.flow === 'connected' ? 'ok' : '' };
    if (next.flow !== 'waiting') polling = false;
    overview.value = next.accounts.length ? await getMailOverview() : null;
  } catch {
    loadError.value = 'Could not load your mail. Is the server running?';
  }
}

/** Every action goes through here: one busy flag, one notice, and a reload of whatever the action changed. */
async function run(job: () => Promise<string | void>, failure: string) {
  busy.value = true;
  notice.value = null;
  try {
    const text = await job();
    if (text) notice.value = { text, tone: 'ok' };
    await load();
    version.value++;
  } catch (err) {
    notice.value = { text: err instanceof ApiError && err.detail === 'name_taken' ? 'A category with that name already exists.' : failure, tone: 'danger' };
  } finally {
    busy.value = false;
  }
}

async function connect() {
  notice.value = null;
  // Opened before the await, or the browser treats it as an unwanted popup.
  const tab = window.open('about:blank', '_blank');
  busy.value = true;
  try {
    const { url } = await connectMailAccount();
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else notice.value = { text: 'Your browser blocked the Google tab. Allow pop-ups for this page and try again.', tone: 'danger' };
    polling = true;
    clearTimeout(poll);
    await load();
  } catch (err) {
    tab?.close();
    notice.value = { text: err instanceof ApiError && err.detail === 'gmail_not_set_up' ? 'The Google client is not saved yet. Follow the steps below.' : 'Could not start connecting. Try again.', tone: 'danger' };
  } finally {
    busy.value = false;
  }
}

const disconnect = (a: MailAccount, keep: boolean) =>
  run(async () => {
    const { revoked } = await disconnectMailAccount(a.id, keep);
    return revoked ? 'Disconnected, and access is revoked at Google.' : 'Disconnected here, but Google could not be reached. Remove the app under Security in your Google Account.';
  }, 'Could not disconnect. Try again.');
const consent = (on: boolean) => run(async () => void (await setMailConsent(on)), 'Could not change that setting.');
const refresh = () =>
  run(async () => {
    const { queued } = await refreshParagraphs();
    return queued ? `Writing ${plural(queued, 'paragraph')}.` : 'Nothing new since the last paragraphs.';
  }, 'Could not refresh the paragraphs.');
const clear = () => run(async () => void (await clearParagraphs()), 'Could not clear the paragraphs.');
const add = () =>
  run(async () => {
    const { id } = await addMailCategory(newName.value.trim());
    newName.value = '';
    adding.value = false;
    open(String(id));
    return 'Category added. It applies to mail from now on.';
  }, 'Could not add that category.');

onMounted(load);
onBeforeUnmount(() => clearTimeout(poll));
</script>

<template>
  <main class="page mail-page">
    <header class="mail-head">
      <h1>Email</h1>
      <p v-if="live.length" class="status-line" role="status">
        <template v-for="(p, i) in status" :key="p.text"><span v-if="i" class="sep" aria-hidden="true"> · </span><span :class="p.tone">{{ p.text }}</span></template>
      </p>
      <p v-else class="status-line">Read-only access to your Gmail. The app never sends, labels, archives or deletes anything.</p>
    </header>

    <p v-if="loadError" class="notice danger" role="alert">{{ loadError }} <button type="button" @click="load">Try again</button></p>
    <p v-if="notice" class="notice" :class="notice.tone" role="status">{{ notice.text }}</p>

    <section v-if="state && !state.setup" class="notice attention setup" aria-labelledby="setup-title">
      <h2 id="setup-title">Set up Google once</h2>
      <ol>
        <li>Create a Google Cloud project and enable the Gmail API.</li>
        <li>On the Google Auth platform, create a <strong>Desktop app</strong> OAuth client. Choose External and <strong>In production</strong>. The secret is shown only once, so save it when it appears.</li>
        <li>Run <code>pnpm secrets set gmail_client_id</code> and <code>pnpm secrets set gmail_client_secret</code>, then reload this page.</li>
      </ol>
      <p>Google warns that the app is unverified, once per account. That is expected for an app only you use.</p>
    </section>

    <section v-else-if="state && !state.accounts.length" class="first-run" aria-labelledby="first-title">
      <h2 id="first-title">Connect your Gmail</h2>
      <p>The app reads your mail, never changes it, and sorts it into categories. Personal mail keeps no text at all; anything sent to Claude is opt-in, redacted and shown here.</p>
      <button type="button" class="primary" :disabled="busy || state.flow === 'waiting'" @click="connect">{{ state.flow === 'waiting' ? 'Waiting for Google…' : 'Connect Gmail' }}</button>
    </section>

    <div v-else-if="state && overview" class="mail-grid">
      <nav class="views" aria-label="Email views">
        <label class="sr-only" for="view-pick">Show</label>
        <select id="view-pick" class="view-pick" :value="viewKey" @change="open(($event.target as HTMLSelectElement).value)">
          <option value="sort">Needs sorting ({{ overview.needs_sorting }})</option>
          <option v-for="c in categories" :key="c.id" :value="String(c.id)">{{ c.name }} ({{ c.count }})</option>
          <option value="rules">Sender rules ({{ overview.rules.length }})</option>
        </select>

        <ul class="view-list">
          <li>
            <button type="button" class="view-item lead" :aria-current="viewKey === 'sort' ? 'page' : undefined" @click="open('sort')">
              <span>Needs sorting</span><span class="n" :class="{ due: overview.needs_sorting }">{{ overview.needs_sorting }}</span>
            </button>
          </li>
        </ul>
        <p id="cat-label" class="group-label">Categories</p>
        <ul class="view-list" aria-labelledby="cat-label">
          <li v-for="c in categories" :key="c.id">
            <button type="button" class="view-item" :aria-current="viewKey === String(c.id) ? 'page' : undefined" @click="open(String(c.id))">
              <span class="name" :title="c.name">{{ c.name }}</span><span class="n">{{ c.count }}</span>
            </button>
          </li>
        </ul>
        <form v-if="adding" class="add" @submit.prevent="add">
          <label class="sr-only" for="new-category">New category name</label>
          <input id="new-category" v-model="newName" type="text" maxlength="60" placeholder="Name" />
          <div class="row">
            <button type="submit" :disabled="busy || !newName.trim()">Add</button>
            <button type="button" class="quiet" @click="(adding = false), (newName = '')">Cancel</button>
          </div>
        </form>
        <button v-else type="button" class="quiet add-open" @click="adding = true">New category</button>
        <ul class="view-list setup-list">
          <li>
            <button type="button" class="view-item" :aria-current="viewKey === 'rules' ? 'page' : undefined" @click="open('rules')">
              <span>Sender rules</span><span class="n">{{ overview.rules.length }}</span>
            </button>
          </li>
        </ul>
      </nav>

      <section class="view" aria-labelledby="view-title">
        <MailSortView v-if="view.kind === 'sort'" :categories="categories" :total="overview.needs_sorting" :version="version" :busy="busy" :run="run" />
        <MailCategoryView v-else-if="view.kind === 'category'" :category="view.category" :categories="categories" :consent="!!overview.consent" :version="version" :busy="busy" :run="run" @removed="open('sort')" />
        <MailRulesView v-else :rules="overview.rules" :categories="categories" :busy="busy" :run="run" />
      </section>

      <MailStatus :accounts="state.accounts" :overview="overview" :busy="busy" :waiting="state.flow === 'waiting'" @connect="connect" @disconnect="disconnect" @consent="consent" @refresh="refresh" @clear="clear" @rules="open('rules')" />
    </div>
    <p v-else-if="!loadError" class="placeholder" role="status">Loading…</p>
  </main>
</template>

<style scoped>
.mail-head { margin-bottom: var(--s5); }
.mail-head h1 { margin-bottom: var(--s1); }
.status-line { color: var(--fg); font-variant-numeric: tabular-nums; margin: 0; }
.status-line .attention { font-weight: 600; color: var(--fg); background: var(--attention-tint); padding: 0 6px; border-radius: 4px; }
.sep { color: var(--muted); }
.setup, .first-run { max-width: 44rem; }
.first-run h2 { margin-top: 0; }

/* views 14rem · gap 32 · open view (fluid) · gap 32 · rail 17rem = the 76rem page minus its 32px gutters */
.mail-grid { display: grid; grid-template-columns: 14rem minmax(0, 1fr) 17rem; gap: var(--s6); align-items: start; }
.views { position: sticky; top: 76px; }
.view-pick { display: none; width: 100%; }
.view-list { list-style: none; margin: 0; padding: 0; }
.view-item {
  width: 100%; display: flex; justify-content: space-between; align-items: center; gap: var(--s2);
  border: 0; border-radius: 6px; background: none; padding: 0 var(--s3); min-height: 34px; font-weight: 450; color: var(--fg); text-align: left;
}
.view-item:hover:not(:disabled) { background: var(--inset); border: 0; }
.view-item[aria-current='page'] { background: var(--inset); font-weight: 600; }
.view-item.lead { font-weight: 600; }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.n { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; font-weight: 450; }
.n.due { color: var(--fg); font-weight: 600; }
.group-label { font-size: 13px; line-height: 18px; font-weight: 600; color: var(--muted); margin: var(--s5) 0 var(--s1) var(--s3); }
.add-open { margin: var(--s1) 0 0 var(--s1); }
.add { padding: var(--s2) var(--s3) 0; display: grid; gap: var(--s2); }
.setup-list { margin-top: var(--s5); padding-top: var(--s3); border-top: 1px solid var(--border); }
.view { min-width: 0; }
.view :deep(.view-head) { margin-bottom: var(--s5); }
.view :deep(.view-head h2) { margin: 0 0 var(--s1); }
.view :deep(.view-head h2:focus) { outline: none; }

@media (max-width: 1100px) {
  .mail-grid { grid-template-columns: 13rem minmax(0, 1fr); }
  .mail-grid > :deep(.rail) { grid-column: 2; }
}
@media (max-width: 720px) {
  .mail-grid { grid-template-columns: minmax(0, 1fr); gap: var(--s5); }
  .mail-grid > :deep(.rail) { grid-column: 1; }
  .views { position: static; }
  .view-pick { display: block; }
  .view-list, .group-label, .add-open, .add { display: none; }
}
</style>
