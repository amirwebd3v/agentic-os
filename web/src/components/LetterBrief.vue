<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ApplicationDetail, Point } from '../api';
import type { MasterTarget } from '../masterAdd';

// The cover-letter agent's work (career-v2 §5): company and vacancy analysis, and the questions it needs answered.
// All text is model or owner output: rendered with {{ }} and v-model only.
const props = defineProps<{ app: ApplicationDetail; busy: boolean }>();
const emit = defineEmits<{ answer: [answers: { id: string; text: string | null }[]]; toMaster: [target: MasterTarget, text: string] }>();

const asking = computed(() => props.app.status === 'needs_answers' && !!props.app.questions?.questions.length);
const drafts = ref<Record<string, string>>({});
const send = () => emit('answer', (props.app.questions?.questions ?? []).map((q) => ({ id: q.id, text: drafts.value[q.id]?.trim() || null })));

// "Add to my master CV": a section or an entry of the master, picked per answer.
const targets = computed(() => [
  { key: 'Summary', label: 'Summary', t: { section: 'Summary' } as MasterTarget },
  { key: 'Skills', label: 'Skills', t: { section: 'Skills' } as MasterTarget },
  ...(props.app.master_entries ?? []).map((e) => ({ key: e.id, label: e.header.split(' | ').slice(0, 2).filter(Boolean).join(', '), t: { entry: e.id } as MasterTarget })),
]);
const where = ref<Record<string, string>>({});
const added = ref<Record<string, boolean>>({});
const toMaster = (answerId: string, text: string) => {
  const t = targets.value.find((x) => x.key === (where.value[answerId] ?? 'Summary'));
  if (!t) return;
  emit('toMaster', t.t, text);
  added.value[answerId] = true;
};
const questionText = (qid: string) => props.app.questions?.questions.find((q) => q.id === qid)?.text ?? '';
const points = (ps: Point[] | undefined) => ps ?? [];
</script>

<template>
  <div class="brief">
    <section v-if="asking" class="notice attention" aria-labelledby="q-title">
      <h2 id="q-title">The letter needs your answers</h2>
      <p>Your CVs don't show these yet. Answer what is true, leave the rest empty to skip; the letter uses only what you write.</p>
      <form class="questions" @submit.prevent="send">
        <div v-for="q in app.questions!.questions" :key="q.id" class="question">
          <label :for="`ans-${q.id}`"><strong>{{ q.text }}</strong></label>
          <p class="hint">{{ q.why }}</p>
          <textarea :id="`ans-${q.id}`" v-model="drafts[q.id]" rows="3" maxlength="2000" placeholder="Leave empty to skip"></textarea>
        </div>
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Sending…' : 'Write the letter' }}</button>
      </form>
    </section>

    <details v-if="app.company_brief || app.vacancy || app.answers" class="built" :open="!asking">
      <summary>How the letter was built</summary>
      <section v-if="app.company_brief">
        <h3>The company</h3>
        <p v-if="!app.company_brief.has_research" class="hint">You gave no research notes, so this comes from the posting only.</p>
        <ul class="points">
          <li v-for="p in points(app.company_brief.points)" :key="p.id">
            <span class="tag" :class="{ attention: p.status === 'assumption' }">{{ p.status === 'verified' ? 'Verified' : 'Assumption' }}</span> {{ p.text }}
            <q v-for="(qt, i) in p.quotes" :key="i" class="hint">{{ qt }}</q>
          </li>
        </ul>
      </section>
      <section v-if="app.vacancy">
        <h3>Why the role is open</h3>
        <p>{{ app.vacancy.why_open.text }}</p>
        <h3>The problem it should solve</h3>
        <p>{{ app.vacancy.business_problem.text }}</p>
        <h3>The three outcomes that matter</h3>
        <ol><li v-for="o in app.vacancy.outcomes" :key="o.id">{{ o.text }}</li></ol>
        <h3>Likely priorities, first 6 to 12 months</h3>
        <ul><li v-for="p in app.vacancy.priorities" :key="p.id">{{ p.text }}</li></ul>
      </section>
      <section v-if="app.answers?.answers.length">
        <h3>Your answers</h3>
        <ul class="answers">
          <li v-for="a in app.answers.answers" :key="a.id">
            <p class="hint">{{ questionText(a.question_id) }}</p>
            <p v-if="a.text">{{ a.text }}</p>
            <p v-else class="hint">Skipped.</p>
            <div v-if="a.text" class="row">
              <span v-if="added[a.id]" class="hint">Added to your master CV.</span>
              <template v-else>
                <label class="hint" :for="`where-${a.id}`">Add to my master CV under</label>
                <select :id="`where-${a.id}`" v-model="where[a.id]">
                  <option v-for="t in targets" :key="t.key" :value="t.key">{{ t.label }}</option>
                </select>
                <button type="button" class="quiet" :disabled="busy" @click="toMaster(a.id, a.text)">Add</button>
              </template>
            </div>
          </li>
        </ul>
      </section>
    </details>
  </div>
</template>
