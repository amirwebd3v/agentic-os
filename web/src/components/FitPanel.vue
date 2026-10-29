<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ApplicationDetail, Suggestion } from '../api';

// Gap analysis and the ATS check (career-v2 §3, §4). All text is model output: rendered with {{ }} only.
const props = defineProps<{ app: ApplicationDetail; editable: boolean; busy: boolean; dirty: boolean }>();
const emit = defineEmits<{ recheck: []; dismiss: [ids: string[]]; accept: [s: Suggestion, text: string, alsoMaster: boolean] }>();

const gaps = computed(() => props.app.gaps ?? null);
const ats = computed(() => props.app.ats ?? null);
const open = computed(() => gaps.value?.suggestions.filter((s) => !gaps.value!.dismissed.includes(s.id)) ?? []);
const ready = computed(() => !!ats.value && ats.value.score >= 80 && !ats.value.findings.some((f) => f.severity === 'high'));
const SEVERITY = { high: 'Must fix', medium: 'Should fix', low: 'Could fix' } as const;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const stale = computed(() => !!ats.value && !!props.app.draft && ats.value.draft_version !== props.app.draft.versions);

// Accepting asks "is this true for you?" with the text editable; nothing enters the CV on its own.
const accepting = ref<string | null>(null);
const text = ref('');
const truthful = ref(false);
const alsoMaster = ref(true);
function start(s: Suggestion) {
  accepting.value = s.id;
  text.value = s.text;
  truthful.value = false;
  alsoMaster.value = true;
}
function confirm(s: Suggestion) {
  if (!truthful.value || !text.value.trim()) return;
  emit('accept', s, text.value.trim(), alsoMaster.value);
  accepting.value = null;
}
</script>

<template>
  <div class="fit">
    <section class="panel" aria-labelledby="ats-title">
      <header class="spread">
        <h2 id="ats-title">ATS check</h2>
        <button type="button" :disabled="busy || dirty || !app.draft" :title="dirty ? 'Save the draft first' : ''" @click="emit('recheck')">
          {{ busy ? 'Checking…' : ats ? 'Re-check ATS' : 'Run the ATS check' }}
        </button>
      </header>
      <p v-if="dirty" class="hint">Save your changes, then re-check: the check reads the saved draft.</p>
      <template v-if="ats">
        <div class="score-row">
          <p class="score" :aria-label="`Score ${ats.score} out of 100`">{{ ats.score }}<span>/100</span></p>
          <p>
            <strong>{{ ready ? 'Ready to download.' : 'Not there yet.' }}</strong>
            {{ ready ? 'It reads well to an applicant tracking system.' : 'Fix what is marked below, save, then re-check.' }}
            <span class="hint">Scored {{ when(ats.created_at) }} on version {{ ats.draft_version }}<template v-if="stale">; the draft has changed since</template>.</span>
          </p>
        </div>
        <ul class="rowbars">
          <li v-for="p in ats.parts" :key="p.name">
            <span class="name">{{ p.name }}</span>
            <span class="track"><i :style="{ width: `${(p.score / Math.max(1, p.max)) * 100}%` }"></i></span>
            <span class="val">{{ p.score }}/{{ p.max }}</span>
          </li>
        </ul>
        <ul v-if="ats.findings.length" class="findings">
          <li v-for="(f, i) in ats.findings" :key="i"><span class="tag" :class="{ attention: f.severity !== 'low' }">{{ SEVERITY[f.severity] }}</span> {{ f.text }}</li>
        </ul>
        <p v-if="ats.history.length > 1" class="hint">Earlier scores: {{ ats.history.slice(1, 6).map((h) => `${h.score} (v${h.draft_version})`).join(', ') }}</p>
      </template>
      <p v-else class="hint">No score yet. It runs by itself after the CV is checked, or press the button.</p>
    </section>

    <section v-if="gaps" class="panel" aria-labelledby="gaps-title">
      <h2 id="gaps-title">Gaps against the posting</h2>
      <template v-if="gaps.missing_keywords.length">
        <h3>Keywords</h3>
        <ul class="keywords">
          <li v-for="k in gaps.missing_keywords" :key="k.keyword" :class="{ have: k.in_master }">
            {{ k.keyword }} <span class="hint">{{ k.importance === 'must' ? 'must have' : 'nice to have' }} · {{ k.in_master ? 'in your master CV' : 'not in your CVs' }}</span>
          </li>
        </ul>
      </template>
      <template v-if="gaps.weak_sections.length">
        <h3>Weak sections</h3>
        <ul><li v-for="(w, i) in gaps.weak_sections" :key="i"><strong>{{ w.section }}:</strong> {{ w.problem }}</li></ul>
      </template>
      <template v-if="gaps.formatting.length">
        <h3>Formatting</h3>
        <ul><li v-for="(f, i) in gaps.formatting" :key="i">{{ f.problem }}</li></ul>
      </template>

      <h3>Suggestions <span class="hint">{{ open.length }}</span></h3>
      <p class="hint">Ideas for lines you might truthfully add. Nothing goes into your CV unless you confirm it is true.</p>
      <ul class="suggestions">
        <li v-for="s in open" :key="s.id">
          <p class="line-text">{{ s.text }}</p>
          <p class="hint">{{ s.section }}<template v-if="s.keyword"> · adds “{{ s.keyword }}”</template> · {{ s.why }}</p>
          <form v-if="accepting === s.id" class="accept" @submit.prevent="confirm(s)">
            <label class="sr-only" :for="`sugg-${s.id}`">The line, as you would say it</label>
            <textarea :id="`sugg-${s.id}`" v-model="text" rows="2" maxlength="2000"></textarea>
            <label class="check"><input v-model="truthful" type="checkbox" /> This is true for me</label>
            <label class="check"><input v-model="alsoMaster" type="checkbox" /> Also add it to my master CV</label>
            <div class="row">
              <button type="submit" :disabled="!truthful || !text.trim() || busy">Add to the CV</button>
              <button type="button" class="quiet" @click="accepting = null">Cancel</button>
            </div>
          </form>
          <div v-else-if="editable" class="row">
            <button type="button" class="quiet" @click="start(s)">Use this</button>
            <button type="button" class="quiet" :disabled="busy" @click="emit('dismiss', [...gaps.dismissed, s.id])">Dismiss</button>
          </div>
        </li>
      </ul>
      <p v-if="gaps.dismissed.length" class="hint">
        {{ gaps.dismissed.length }} dismissed. <button type="button" class="quiet" :disabled="busy" @click="emit('dismiss', [])">Show them again</button>
      </p>
    </section>
  </div>
</template>
