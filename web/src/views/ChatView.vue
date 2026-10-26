<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { ApiError, endSession } from '../api';
import { useSessionsStore } from '../stores/sessions';
import MessageBubble from '../components/MessageBubble.vue';

const props = defineProps<{ id?: number }>();
const sessions = useSessionsStore();
const draft = ref('');
const loadError = ref<string | null>(null);
const list = ref<HTMLElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);

const open = computed(() => (sessions.current?.session.id === props.id ? sessions.current : null));
const streamingHere = computed(() => sessions.streaming?.open.session.id === props.id);
const focusInput = () => nextTick(() => input.value?.focus());

onMounted(async () => {
  if (props.id === undefined) return;
  try {
    await sessions.open(props.id);
    await focusInput();
  } catch (err) {
    loadError.value = err instanceof ApiError && err.status === 404 ? 'Session not found.' : "Couldn't load the session.";
  }
});

// Keep the newest text in view while it streams.
watch(
  () => open.value?.messages.at(-1)?.content,
  () => nextTick(() => list.value?.lastElementChild?.scrollIntoView({ block: 'end' })),
);

async function send() {
  const content = draft.value.trim();
  if (!content || sessions.streaming) return;
  draft.value = '';
  // The Send/Stop swap destroys the focused button, so keep keyboard users in the composer.
  void focusInput();
  if (!(await sessions.send(content))) draft.value = content;
}
// Also when you navigated away and back mid-reply: this view isn't the one that called send().
watch(streamingHere, (now) => now || focusInput());

function onKey(e: KeyboardEvent) {
  // keyCode 229: Safari reports the IME-confirming Enter with isComposing false.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    void send();
  }
}

const ended = ref<string | null>(null);
/** Files the session now (persona: proposes statements for review) instead of waiting for the idle timer. */
async function end() {
  const cur = open.value;
  if (!cur) return;
  try {
    await endSession(cur.session.id);
    ended.value = cur.session.mode === 'persona' ? 'Ended. Your answers will show up on the Review page shortly.' : 'Ended. The session will be filed shortly.';
  } catch {
    ended.value = "Couldn't end the session.";
  }
}

function rename(e: Event) {
  const el = e.target as HTMLInputElement;
  const cur = open.value;
  const title = el.value.trim();
  if (!cur || !title || title === cur.session.title) return;
  sessions.update(cur.session.id, { title }).catch(() => {
    cur.error = "Couldn't rename the session.";
    el.value = cur.session.title ?? '';
  });
}
</script>

<template>
  <main class="chat">
    <p v-if="id === undefined" class="placeholder">Pick a session or start a new one.</p>
    <p v-else-if="loadError" class="error" role="alert">{{ loadError }}</p>
    <p v-else-if="!open" class="placeholder">Loading…</p>
    <template v-else>
      <header>
        <label for="title" class="sr-only">Session title</label>
        <input id="title" :value="open.session.title ?? ''" placeholder="Untitled" maxlength="200" @change="rename" />
        <span class="mode">{{ open.session.mode }}</span>
        <button type="button" :disabled="streamingHere || !open.messages.length" @click="end">End session</button>
      </header>
      <p v-if="ended" class="placeholder" role="status">{{ ended }}</p>
      <ol ref="list" class="messages" aria-label="Messages">
        <MessageBubble v-for="(m, i) in open.messages" :key="`${i}-${m.role}`" :message="m" />
      </ol>
      <p v-if="open.error" class="error" role="alert">{{ open.error }}</p>
      <p v-if="sessions.streaming && !streamingHere" class="placeholder">
        Another session is still replying; you can send once it finishes.
      </p>
      <form class="composer" @submit.prevent="send">
        <label for="draft" class="sr-only">Message</label>
        <textarea
          id="draft"
          ref="input"
          v-model="draft"
          rows="3"
          maxlength="20000"
          placeholder="Message (Enter sends, Shift+Enter adds a line)"
          @keydown="onKey"
        />
        <button v-if="streamingHere" type="button" @click="sessions.stop()">Stop</button>
        <button v-else type="submit" :disabled="!draft.trim() || !!sessions.streaming">Send</button>
      </form>
    </template>
  </main>
</template>
