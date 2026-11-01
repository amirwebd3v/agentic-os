<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiError, connectMailAccount, disconnectMailAccount, getMailAccounts } from '../api';
import type { ConnectFlow, MailAccount, MailAccounts } from '../api';

const state = ref<MailAccounts>();
const loadError = ref('');
const notice = ref('');
const confirming = ref<number | null>(null);
const busy = ref(false);
let poll: ReturnType<typeof setTimeout> | undefined;

const FLOW_TEXT: Partial<Record<ConnectFlow, string>> = {
  connected: 'Connected. Nothing is read from this account yet.',
  cancelled: 'Nothing was connected.',
  timed_out: 'The wait for Google ran out. Nothing was connected.',
  wrong_scope: 'Google gave wider access than read-only, so the app refused and revoked it. Nothing was connected.',
  failed: 'Connecting failed. Nothing was stored. Try again.',
};
const STATUS_TEXT: Record<MailAccount['status'], string> = {
  connected: 'Connected, read-only',
  reconnect: 'Needs reconnecting',
  disconnected: 'Disconnected, local mail kept',
};

async function load() {
  loadError.value = '';
  try {
    const next = await getMailAccounts();
    state.value = next;
    if (next.flow === 'waiting') poll = setTimeout(() => void load(), 2000);
    else if (FLOW_TEXT[next.flow] && polling) notice.value = FLOW_TEXT[next.flow]!;
    if (next.flow !== 'waiting') polling = false;
  } catch {
    loadError.value = 'Could not load your accounts.';
  }
}
let polling = false;

async function connect() {
  busy.value = true;
  notice.value = '';
  // Opened before the await, or the browser treats it as an unwanted popup.
  const tab = window.open('about:blank', '_blank');
  try {
    const { url } = await connectMailAccount();
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else notice.value = 'Your browser blocked the Google tab. Allow pop-ups for this page and try again.';
    polling = true;
    clearTimeout(poll);
    await load();
  } catch (err) {
    tab?.close();
    notice.value = err instanceof ApiError && err.detail === 'gmail_not_set_up' ? 'The Google client is not saved yet. Follow the steps below.' : 'Could not start connecting. Try again.';
  } finally {
    busy.value = false;
  }
}

async function disconnect(account: MailAccount, keep: boolean) {
  busy.value = true;
  try {
    const { revoked } = await disconnectMailAccount(account.id, keep);
    confirming.value = null;
    notice.value = revoked ? 'Disconnected, and access is revoked at Google.' : 'Disconnected here, but Google could not be reached. Remove the app under Security in your Google Account.';
    await load();
  } catch {
    notice.value = 'Could not disconnect. Try again.';
  } finally {
    busy.value = false;
  }
}

onMounted(load);
onBeforeUnmount(() => clearTimeout(poll));
</script>

<template>
  <main class="page email">
    <header class="page-head spread">
      <div>
        <h1>Email</h1>
        <p class="lede">Read-only access to your Gmail. The app never sends, labels, archives or deletes anything.</p>
      </div>
      <button v-if="state?.setup" type="button" class="primary" :disabled="busy || state.flow === 'waiting'" @click="connect">{{ state.flow === 'waiting' ? 'Waiting for Google…' : 'Connect Gmail' }}</button>
    </header>

    <p v-if="loadError" class="notice danger" role="alert">{{ loadError }} <button type="button" @click="load">Try again</button></p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <section v-if="state && !state.setup" class="notice attention">
      <h2>Set up Google once</h2>
      <ol>
        <li>Create a Google Cloud project and enable the Gmail API.</li>
        <li>On the Google Auth platform, create a <strong>Desktop app</strong> OAuth client. Choose External and <strong>In production</strong>. The secret is shown only once, so save it when it appears.</li>
        <li>Run <code>pnpm secrets set gmail_client_id</code> and <code>pnpm secrets set gmail_client_secret</code>, then reload this page.</li>
      </ol>
      <p>Google warns that the app is unverified, once per account. That is expected for an app only you use.</p>
    </section>

    <section v-if="state?.setup && !state.accounts.length">
      <p>No account connected yet. Connecting reads nothing until sorting is switched on.</p>
    </section>

    <section v-if="state?.accounts.length" aria-label="Accounts">
      <ul class="accounts">
        <li v-for="a in state.accounts" :key="a.id" class="spread">
          <div>
            <strong>{{ a.email }}</strong>
            <p class="muted">{{ STATUS_TEXT[a.status] }}</p>
          </div>
          <div class="row">
            <button v-if="a.status !== 'connected'" type="button" :disabled="busy" @click="connect">Reconnect</button>
            <template v-if="a.status !== 'disconnected' && confirming === a.id">
              <button type="button" :disabled="busy" @click="disconnect(a, true)">Disconnect, keep local mail</button>
              <button type="button" class="danger" :disabled="busy" @click="disconnect(a, false)">Disconnect, delete local mail</button>
              <button type="button" :disabled="busy" @click="confirming = null">Cancel</button>
            </template>
            <button v-else-if="a.status !== 'disconnected'" type="button" :disabled="busy" @click="confirming = a.id">Disconnect</button>
            <button v-else type="button" class="danger" :disabled="busy" @click="disconnect(a, false)">Delete local mail</button>
          </div>
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.accounts { list-style: none; margin: 0; padding: 0; }
.accounts li { border-top: 1px solid var(--border); padding: var(--s4) 0; }
.accounts p { margin: 0; }
</style>
