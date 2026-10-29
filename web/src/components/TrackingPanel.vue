<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import {
  addMilestone, ApiError, deleteMilestone, editMilestone, setFollowUp,
  type ApplicationDetail, type Milestone, type MilestoneInput, type MilestoneKind,
} from '../api';
import { dayText, MILESTONE_TEXT, today, useCareerStore } from '../stores/career';

// Notes are your own text: rendered with {{ }} only, like everything else. Nothing here uses v-html.
const props = defineProps<{ app: ApplicationDetail }>();
const career = useCareerStore();
const KINDS = Object.keys(MILESTONE_TEXT) as MilestoneKind[];
// The server takes milestones once the draft is final and its files are done (contract §8.2).
const shown = computed(() => ['final', 'applied', 'withdrawn'].includes(props.app.status) && props.app.step !== 'render');

const fresh = (): MilestoneInput => ({ kind: props.app.milestones.length ? 'feedback' : 'applied', on_date: today(), note: '' });
const draft = ref(fresh());
const editing = ref<number | null>(null);
const edit = ref<MilestoneInput>(fresh());
const followUp = ref(props.app.follow_up_on ?? '');
const busy = ref(false);
const error = ref<string | null>(null);

const ERRORS: Record<string, string> = {
  bad_date: 'That is not a valid date.',
  wrong_status: 'This application changed in the meantime. Reload the page.',
  not_found: 'That entry no longer exists. Reload the page.',
};
async function act(fn: () => Promise<ApplicationDetail>, done?: () => void) {
  busy.value = true;
  error.value = null;
  try {
    await career.change(fn);
    done?.();
  } catch (err) {
    const code = err instanceof ApiError ? err.detail : undefined;
    error.value = (code && ERRORS[code]) || "That didn't work. Is the server running?";
  } finally {
    busy.value = false;
  }
}

const what = (m: Milestone) => `${MILESTONE_TEXT[m.kind]} on ${dayText(m.on_date)}`;
const focusEdit = (mid: number) => nextTick(() => document.getElementById(`milestone-${mid}-edit`)?.focus());
async function startEdit(m: Milestone) {
  editing.value = m.id;
  edit.value = { kind: m.kind, on_date: m.on_date, note: m.note ?? '' };
  await nextTick();
  document.getElementById(`milestone-${m.id}-kind`)?.focus();
}
function stopEdit(mid: number) {
  editing.value = null;
  void focusEdit(mid);
}
const add = () => act(() => addMilestone(props.app.id, draft.value), () => (draft.value = fresh()));
const save = (mid: number) => act(() => editMilestone(props.app.id, mid, edit.value), () => stopEdit(mid));
function remove(m: Milestone) {
  if (window.confirm(`Delete “${what(m)}”${m.note ? ' and its note' : ''}?`)) void act(() => deleteMilestone(props.app.id, m.id));
}
const saveFollowUp = () => act(() => setFollowUp(props.app.id, followUp.value || null));
</script>

<template>
  <section v-if="shown" class="tracking" aria-labelledby="tracking-title">
    <h2 id="tracking-title">Tracking</h2>
    <p v-if="error" class="notice danger" role="alert">{{ error }}</p>

    <p v-if="!app.milestones.length" class="hint">Nothing noted yet. Note the day you applied, then feedback, interviews and the result.</p>
    <ol v-else class="timeline">
      <li v-for="m in app.milestones" :key="m.id">
        <form v-if="editing === m.id" class="milestone-form" :aria-label="`Edit ${what(m)}`" @submit.prevent="save(m.id)" @keydown.esc="stopEdit(m.id)">
          <label>What <select :id="`milestone-${m.id}-kind`" v-model="edit.kind"><option v-for="k in KINDS" :key="k" :value="k">{{ MILESTONE_TEXT[k] }}</option></select></label>
          <label>On <input v-model="edit.on_date" type="date" required /></label>
          <label class="wide">Note <textarea v-model="edit.note" rows="2" maxlength="2000"></textarea></label>
          <div class="row">
            <button type="submit" :disabled="busy || !edit.on_date">Save</button>
            <button type="button" @click="stopEdit(m.id)">Cancel</button>
          </div>
        </form>
        <template v-else>
          <time :datetime="m.on_date">{{ dayText(m.on_date) }}</time>
          <div class="milestone">
            <strong>{{ MILESTONE_TEXT[m.kind] }}</strong>
            <span v-if="m.on_date >= today()" class="tag">Upcoming</span>
            <p v-if="m.note" class="note">{{ m.note }}</p>
          </div>
          <span class="row">
            <button :id="`milestone-${m.id}-edit`" type="button" class="quiet" :aria-label="`Edit ${what(m)}`" :disabled="busy" @click="startEdit(m)">Edit</button>
            <button type="button" class="quiet" :aria-label="`Delete ${what(m)}`" :disabled="busy" @click="remove(m)">Delete</button>
          </span>
        </template>
      </li>
    </ol>

    <form class="milestone-form" aria-label="Add to the timeline" @submit.prevent="add">
      <label>What <select v-model="draft.kind"><option v-for="k in KINDS" :key="k" :value="k">{{ MILESTONE_TEXT[k] }}</option></select></label>
      <label>On <input v-model="draft.on_date" type="date" required /></label>
      <label class="wide">Note, optional <textarea v-model="draft.note" rows="2" maxlength="2000" placeholder="Who you spoke to, what comes next…"></textarea></label>
      <div class="row"><button type="submit" :disabled="busy || !draft.on_date">Add to timeline</button></div>
    </form>

    <form class="row follow-up" @submit.prevent="saveFollowUp">
      <label>Follow up on <input v-model="followUp" type="date" /></label>
      <button type="submit" :disabled="busy">Save follow-up</button>
      <span class="hint">Leave empty for none.</span>
    </form>
  </section>
</template>
