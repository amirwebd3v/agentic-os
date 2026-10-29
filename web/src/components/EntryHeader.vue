<script setup lang="ts">
import { nextTick, reactive, ref } from 'vue';
import type { DraftEdit, HeaderField } from '../api';

// Header values come from the master or the user: rendered with {{ }} and v-model only.
const props = defineProps<{ entryId: string; header: Record<HeaderField, string>; editable: boolean; edited: boolean; busy: boolean }>();
const emit = defineEmits<{ save: [edits: DraftEdit[], done: () => void]; remove: [] }>();

const FIELDS: { key: HeaderField; label: string }[] = [
  { key: 'org', label: 'Employer or school' },
  { key: 'title', label: 'Title' },
  { key: 'start', label: 'Start' },
  { key: 'end', label: 'End' },
  { key: 'location', label: 'Location' },
];
const editing = ref(false);
const values = reactive({ org: '', title: '', start: '', end: '', location: '' } as Record<HeaderField, string>);
const inputs = ref<HTMLInputElement[]>([]);
const editButton = ref<HTMLButtonElement>();
const name = () => props.header.org || props.entryId;

async function start() {
  Object.assign(values, props.header);
  editing.value = true;
  await nextTick();
  inputs.value[0]?.focus();
}
async function cancel() {
  editing.value = false;
  await nextTick();
  editButton.value?.focus();
}
function save() {
  // Only changed fields are sent; a blank one is a `remove`, so it renders empty instead of the master's value.
  const edits = FIELDS.flatMap(({ key }): DraftEdit[] => {
    const value = values[key].trim();
    if (value === props.header[key]) return [];
    const ref = `cv.entries.${props.entryId}.header.${key}`;
    return [value ? { ref, text: value } : { op: 'remove', ref }];
  });
  if (!edits.length) return void cancel();
  emit('save', edits, () => void cancel());
}
</script>

<template>
  <div class="entry-head">
    <form
      v-if="editing" class="line-edit"
      @submit.prevent="save" @keydown.esc.prevent="cancel" @keydown.ctrl.enter.prevent="save" @keydown.meta.enter.prevent="save"
    >
      <label v-for="f in FIELDS" :key="f.key">
        {{ f.label }}
        <input ref="inputs" v-model="values[f.key]" type="text" maxlength="120" />
      </label>
      <div class="row">
        <button type="submit" :disabled="busy">Save header</button>
        <button type="button" :disabled="busy" @click="cancel">Cancel</button>
        <span class="hint">Ctrl+Enter saves, Esc cancels</span>
      </div>
    </form>
    <template v-else>
      <h3>{{ name() }}<span v-if="header.title" class="entry-title"> · {{ header.title }}</span></h3>
      <p v-if="header.start || header.end || header.location" class="hint">
        {{ [[header.start, header.end].filter(Boolean).join(' – '), header.location].filter(Boolean).join(' · ') }}
      </p>
      <p v-if="edited" class="line-meta"><span class="tag">Edited by you, not re-checked</span></p>
      <span v-if="editable" class="line-actions">
        <button ref="editButton" type="button" class="quiet" :aria-label="`Edit the header of ${name()}`" @click="start">Edit</button>
        <button type="button" class="quiet" :disabled="busy" :aria-label="`Remove ${name()} from the CV`" @click="emit('remove')">Remove</button>
      </span>
    </template>
  </div>
</template>
