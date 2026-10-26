<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Approval, Decision } from '../api';
import { lineDiff } from '../diff';

// Everything in `approval` is model- or file-supplied: it is only ever rendered with {{ }} (text), never v-html.
const props = defineProps<{ approval: Approval; busy: boolean }>();
const selected = defineModel<boolean>('selected', { default: false });
const emit = defineEmits<{ decide: [decision: Decision, finalText?: string] }>();

const editing = ref(false);
const draft = ref(props.approval.original_text ?? '');
const titleId = `approval-${props.approval.id}-title`;

const diff = computed(() =>
  props.approval.action_type === 'vault_conflict'
    ? lineDiff(props.approval.current_text ?? '', props.approval.payload.content)
    : [],
);
// A type the UI doesn't know yet (a newer server) still renders, as raw JSON.
const unknown = computed(() => props.approval as unknown as { action_type: string; payload: unknown });
const approve = () => emit('decide', 'approve', editing.value ? draft.value.trim() : undefined);
</script>

<template>
  <article class="card" :aria-labelledby="titleId">
    <header>
      <input v-model="selected" type="checkbox" :aria-label="`Select item ${approval.id}`" />
      <h2 :id="titleId">
        <template v-if="approval.action_type === 'propose_category'">
          New {{ approval.payload.parent_slug ? 'subarea' : 'area' }}: {{ approval.payload.name }}
        </template>
        <template v-else-if="approval.action_type === 'vault_conflict'">Note changed in the vault: {{ approval.payload.path }}</template>
        <template v-else-if="approval.action_type === 'persona_statement'">About you ({{ approval.payload.topic }})</template>
        <template v-else>{{ unknown.action_type }}</template>
      </h2>
      <time :datetime="approval.created_at">{{ new Date(approval.created_at).toLocaleDateString() }}</time>
    </header>

    <dl v-if="approval.action_type === 'propose_category'">
      <dt>Slug</dt><dd><code>{{ approval.payload.slug }}</code></dd>
      <template v-if="approval.payload.parent_slug"><dt>Under</dt><dd><code>{{ approval.payload.parent_slug }}</code></dd></template>
      <dt>Description</dt>
      <dd>
        <textarea v-if="editing" v-model="draft" rows="3" maxlength="2000" :aria-label="`Edit description for ${approval.payload.name}`" />
        <template v-else>{{ approval.payload.description }}</template>
      </dd>
      <template v-if="approval.payload.reason"><dt>Why</dt><dd>{{ approval.payload.reason }}</dd></template>
      <dt>Sessions waiting</dt><dd>{{ approval.payload.session_ids.length }}</dd>
    </dl>

    <dl v-else-if="approval.action_type === 'persona_statement'">
      <template v-if="approval.payload.question"><dt>Question</dt><dd>{{ approval.payload.question }}</dd></template>
      <dt>You said</dt><dd><q>{{ approval.payload.in_my_words }}</q></dd>
      <dt>Statement</dt>
      <dd>
        <textarea v-if="editing" v-model="draft" rows="3" maxlength="2000" aria-label="Edit the statement" />
        <template v-else>{{ approval.payload.statement }}</template>
      </dd>
    </dl>

    <template v-else-if="approval.action_type === 'vault_conflict'">
      <p class="hint">
        Approve to replace your version with the app's (<span class="del">−</span> yours, <span class="add">+</span> app's). Reject keeps yours.
      </p>
      <pre class="diff"><span v-for="(l, i) in diff" :key="i" :class="{ add: l.op === '+', del: l.op === '-' }">{{ l.op }} {{ l.text }}
</span></pre>
    </template>

    <pre v-else class="plain">{{ JSON.stringify(unknown.payload, null, 2) }}</pre>

    <footer>
      <button type="button" :disabled="busy || (editing && !draft.trim())" @click="approve">
        {{ editing ? 'Save & approve' : 'Approve' }}
      </button>
      <button v-if="approval.original_text !== null && !editing" type="button" :disabled="busy" @click="editing = true">Edit</button>
      <button v-if="editing" type="button" :disabled="busy" @click="editing = false; draft = approval.original_text ?? ''">Cancel edit</button>
      <button type="button" :disabled="busy" @click="emit('decide', 'reject')">Reject</button>
    </footer>
  </article>
</template>
