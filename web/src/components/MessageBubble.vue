<script setup lang="ts">
import { computed } from 'vue';
import type { Message } from '../api';
import { renderMarkdown } from '../markdown';

const props = defineProps<{ message: Message }>();
// ponytail: re-renders the whole reply per delta (O(n²) per reply), render incrementally if long replies lag
const html = computed(() => renderMarkdown(props.message.content));
</script>

<template>
  <li class="msg" :class="message.role">
    <span class="sr-only">{{ message.role === 'user' ? 'You' : 'Assistant' }}:</span>
    <p v-if="message.role === 'user'" class="plain">{{ message.content }}</p>
    <!-- The one v-html in the app: renderMarkdown() sanitizes untrusted model output (see markdown.ts). -->
    <!-- eslint-disable vue/no-v-html -->
    <div
      v-else
      class="md"
      aria-live="polite"
      :aria-busy="message.status === 'streaming'"
      v-html="html"
    />
    <!-- eslint-enable vue/no-v-html -->
    <span v-if="message.status === 'aborted'" class="badge interrupted">interrupted</span>
    <span v-else-if="message.status === 'error'" class="badge error">error</span>
  </li>
</template>
