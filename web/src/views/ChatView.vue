<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { ApiError } from '../api';
import { useSessionsStore } from '../stores/sessions';
import MessageBubble from '../components/MessageBubble.vue';

const props = defineProps<{ id?: number }>();
const sessions = useSessionsStore();
const draft = ref('');
const loadError = ref<string | null>(null);
const list = ref<HTMLElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);

const open = computed(() => (sessions.current?.session.id === props.id ? sessions.current : null));
const streamingHere = computed(() => sessions.streaming?.sessionId === props.id);

onMounted(async () => {
  if (props.id === undefined) return;
  try {
    await sessions.open(props.id);
    await nextTick();
    input.value?.focus();
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
  if (!(await sessions.send(content))) draft.value = content;
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send();
  }
}

function rename(e: Event) {
  const title = (e.target as HTMLInputElement).value.trim();
  if (open.value && title && title !== open.value.session.title)
    sessions.update(open.value.session.id, { title }).catch(() => (sessions.error = "Couldn't rename the session."));
}
</script>

<template>
  <main class="chat">
    <p v-if="id === undefined" class="placeholder">Pick a session or start a new one.</p>
    <p v-else-if="loadError" class="error" role="alert">{{ loadError }}</p>
    <template v-else-if="open">
      <header>
        <label for="title" class="sr-only">Session title</label>
        <input id="title" :value="open.session.title ?? ''" placeholder="Untitled" maxlength="200" @change="rename" />
        <span class="mode">{{ open.session.mode }}</span>
      </header>
      <ol ref="list" class="messages" aria-label="Messages">
        <MessageBubble v-for="(m, i) in open.messages" :key="`${i}-${m.role}`" :message="m" />
      </ol>
      <p v-if="sessions.error" class="error" role="alert">{{ sessions.error }}</p>
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
