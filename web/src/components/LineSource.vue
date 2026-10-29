<script setup lang="ts">
import { computed } from 'vue';
import type { Line } from '../api';
import { wordDiff } from '../diff';

// Line and source text are model and file output: text only ({{ }}), never v-html.
const props = defineProps<{ line: Line; sources: Record<string, string> }>();
const cited = computed(() => (props.line.cites ?? []).map((id) => ({ id, text: props.sources[id] })));
const diff = computed(() => {
  const source = cited.value.flatMap((c) => (c.text === undefined ? [] : [c.text])).join(' ');
  return source ? wordDiff(source, props.line.text) : [];
});
</script>

<template>
  <div class="source">
    <h3 class="label">From your master CV</h3>
    <p v-if="!line.cites?.length" class="hint">{{ line.origin === 'suggestion' ? 'You added this from a gap suggestion and confirmed it is true.' : 'Your own line: it cites nothing in your master CV and is not checked.' }}</p>
    <figure v-for="c in cited" :key="c.id">
      <blockquote v-if="c.text !== undefined">{{ c.text }}</blockquote>
      <p v-else class="missing">Not in your master CV.</p>
      <figcaption><code>{{ c.id }}</code></figcaption>
    </figure>
    <template v-if="diff.length">
      <h3 class="label">Changes from that text</h3>
      <p class="word-diff">
        <template v-for="(d, i) in diff" :key="i">
          <del v-if="d.op === '-'"><span class="sr-only">removed: </span>{{ d.text }}</del>
          <ins v-else-if="d.op === '+'"><span class="sr-only">added: </span>{{ d.text }}</ins>
          <span v-else>{{ d.text }}</span>
        </template>
      </p>
    </template>
  </div>
</template>
