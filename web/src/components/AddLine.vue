<script setup lang="ts">
import { nextTick, ref } from 'vue';

// A line the user writes (contract §8.2): it cites nothing and is not re-checked. Same keys as DraftLine.
const props = defineProps<{ id: string; label: string; max: number; busy: boolean; button?: string }>();
const emit = defineEmits<{ save: [text: string, done: () => void] }>();

const open = ref(false);
const text = ref('');
const box = ref<HTMLTextAreaElement>();
const opener = ref<HTMLButtonElement>();

async function start() {
  text.value = '';
  open.value = true;
  await nextTick();
  box.value?.focus();
}
async function cancel() {
  open.value = false;
  await nextTick();
  opener.value?.focus();
}
function save() {
  const value = text.value.trim();
  if (!value) return void cancel();
  emit('save', value, () => void cancel());
}
</script>

<template>
  <form v-if="open" class="line-edit" @submit.prevent="save" @keydown.esc.prevent="cancel">
    <label :for="`add-${props.id}`" class="sr-only">{{ label }}</label>
    <textarea
      :id="`add-${props.id}`"
      ref="box"
      v-model="text"
      :maxlength="max"
      :rows="Math.min(12, Math.ceil(text.length / 70) + 1)"
      @keydown.ctrl.enter.prevent="save"
      @keydown.meta.enter.prevent="save"
    ></textarea>
    <div class="row">
      <button type="submit" :disabled="busy">Add</button>
      <button type="button" :disabled="busy" @click="cancel">Cancel</button>
      <span class="hint">{{ text.length }} / {{ max }} · Ctrl+Enter adds, Esc cancels</span>
    </div>
  </form>
  <button v-else ref="opener" type="button" class="quiet" :aria-label="label" @click="start">{{ props.button ?? 'Add line' }}</button>
</template>
