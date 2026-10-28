<script setup lang="ts">
import { nextTick, ref } from 'vue';
import type { Line, VerifyReport } from '../api';
import { violationText } from '../stores/career';

// `line.text` and violation tokens are model output: rendered with {{ }} only.
const props = defineProps<{
  lineRef: string; label: string; line: Line; focused: boolean; editable: boolean; edited: boolean; busy: boolean;
  violations: VerifyReport['violations']; max: number;
}>();
const emit = defineEmits<{ focus: []; save: [text: string, done: () => void] }>();

const editing = ref(false);
const text = ref('');
const box = ref<HTMLTextAreaElement>();
const editButton = ref<HTMLButtonElement>();

async function start() {
  text.value = props.line.text;
  editing.value = true;
  await nextTick();
  box.value?.focus();
}
async function cancel() {
  editing.value = false;
  await nextTick();
  editButton.value?.focus();
}
function save() {
  const value = text.value.trim();
  if (!value || value === props.line.text) return void cancel();
  emit('save', value, () => void cancel());
}
</script>

<template>
  <li
    class="line"
    :class="{ focused, flagged: violations.length && !edited, edited }"
    :data-ref="lineRef"
    @focusin="emit('focus')"
    @click="emit('focus')"
  >
    <form v-if="editing" class="line-edit" @submit.prevent="save" @keydown.esc.prevent="cancel">
      <label :for="`edit-${lineRef}`" class="sr-only">{{ label }}</label>
      <textarea
        :id="`edit-${lineRef}`"
        ref="box"
        v-model="text"
        :maxlength="max"
        :rows="Math.min(12, Math.ceil(text.length / 70) + 1)"
        @keydown.ctrl.enter.prevent="save"
        @keydown.meta.enter.prevent="save"
      ></textarea>
      <div class="row">
        <button type="submit" :disabled="busy">Save line</button>
        <button type="button" :disabled="busy" @click="cancel">Cancel</button>
        <span class="hint">{{ text.length }} / {{ max }} · Ctrl+Enter saves, Esc cancels</span>
      </div>
    </form>
    <template v-else>
      <p class="line-text">{{ line.text }}</p>
      <button v-if="editable" ref="editButton" type="button" class="quiet" :aria-label="`Edit ${label}`" @click="start">Edit</button>
      <button v-else type="button" class="quiet" :aria-label="`Show the source of ${label}`">Source</button>
      <p v-if="edited" class="line-meta"><span class="tag">Edited by you, not re-checked</span></p>
      <p v-else-if="violations.length" class="line-meta">
        <span v-for="(v, i) in violations" :key="i" class="tag attention">Check: this line {{ violationText(v) }}</span>
      </p>
    </template>
    <slot />
  </li>
</template>
