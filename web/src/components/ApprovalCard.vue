<script setup lang="ts">
import { computed } from 'vue';
import type { Approval, Decision } from '../api';
import { lineDiff } from '../diff';

// Everything in `approval` is model- or file-supplied: it is only ever rendered with {{ }} (text), never v-html.
const props = defineProps<{ approval: Approval; busy: boolean }>();
const selected = defineModel<boolean>('selected', { default: false });
const emit = defineEmits<{ decide: [decision: Decision] }>();

const titleId = `approval-${props.approval.id}-title`;
const diff = computed(() =>
  props.approval.action_type === 'vault_conflict'
    ? lineDiff(props.approval.current_text ?? '', props.approval.payload.content)
    : [],
);
const known = computed(() => props.approval.action_type === 'vault_conflict');
// A type the UI doesn't know yet (a newer server) still renders, as raw JSON.
const unknown = computed(() => props.approval as unknown as { action_type: string; payload: unknown });
</script>

<template>
  <article class="card" :aria-labelledby="titleId">
    <header>
      <input v-model="selected" type="checkbox" :aria-label="`Select item ${approval.id}`" />
      <h2 :id="titleId">
        <template v-if="approval.action_type === 'vault_conflict'">Note changed in the vault: {{ approval.payload.path }}</template>
        <template v-else>{{ unknown.action_type }}</template>
      </h2>
      <time :datetime="approval.created_at">{{ new Date(approval.created_at).toLocaleDateString() }}</time>
    </header>

    <template v-if="approval.action_type === 'vault_conflict'">
      <p class="hint">
        Approve to replace your version with the app's (<span class="del">−</span> yours, <span class="add">+</span> app's). Reject keeps yours.
      </p>
      <pre class="diff"><span v-for="(l, i) in diff" :key="i" :class="{ add: l.op === '+', del: l.op === '-' }">{{ l.op }} {{ l.text }}
</span></pre>
    </template>

    <template v-else>
      <p class="hint">This version can't apply this item. Reject it to clear it.</p>
      <pre class="plain">{{ JSON.stringify(unknown.payload, null, 2) }}</pre>
    </template>

    <footer>
      <button type="button" :disabled="busy || !known" @click="emit('decide', 'approve')">Approve</button>
      <button type="button" :disabled="busy" @click="emit('decide', 'reject')">Reject</button>
    </footer>
  </article>
</template>
