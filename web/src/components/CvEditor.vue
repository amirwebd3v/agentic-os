<script setup lang="ts">
import { computed, nextTick } from 'vue';
import { badEnd, badStart, blankEntry, blankSection, isEntries, SECTION_ORDER, type CvEntry, type CvLine, type CvSection, type SectionName } from '../cv';

// The one CV editor, for the master CV and for a tailored draft (career-v2.md §1). Text is bound with v-model and
// rendered with {{ }} only. A page adds its own notes under a line through the `meta` slot.
const sections = defineModel<CvSection[]>({ required: true });
const props = withDefaults(defineProps<{ editable?: boolean; focused?: string | null; idPrefix?: string }>(), { editable: true, focused: null, idPrefix: 'cv' });
const emit = defineEmits<{ focus: [line: CvLine] }>();
defineSlots<{ meta?: (p: { line: CvLine }) => unknown; entry?: (p: { entry: CvEntry }) => unknown }>();

const ADD_TEXT: Record<SectionName, string> = {
  Summary: 'Add a summary line', Experience: 'Add a job', Education: 'Add a school or degree', Projects: 'Add a project',
  Certifications: 'Add a certification', Skills: 'Add a skill', Languages: 'Add a language',
};
const PLACEHOLDER: Partial<Record<SectionName, string>> = { Skills: 'e.g. TypeScript', Languages: 'e.g. German (C1)' };
const ORG: Partial<Record<SectionName, string>> = { Education: 'School', Certifications: 'Issuer' };
const missing = computed(() => SECTION_ORDER.filter((n) => !sections.value.some((s) => s.name === n)));
const sid = (s: CvSection) => `${props.idPrefix}-${s.name}`;

// Stable keys for items that have no id yet, without sending anything extra to the server.
const keys = new WeakMap<object, number>();
let next = 0;
const key = (o: object) => keys.get(o) ?? (keys.set(o, ++next), next);

function move<T>(list: T[], i: number, by: number) {
  const j = i + by;
  if (j >= 0 && j < list.length) [list[i], list[j]] = [list[j]!, list[i]!];
}
const drop = <T>(list: T[], i: number) => list.splice(i, 1);
/** Adds an empty item and puts the cursor in it (the last field inside `box`). */
async function add<T>(list: T[], item: T, box: string) {
  list.push(item);
  await nextTick();
  [...document.querySelectorAll<HTMLElement>(`${box} :is(textarea, input)`)].at(-1)?.focus();
}
const removeSection = (s: CvSection) => {
  if (window.confirm(`Remove the whole ${s.name} section?`)) sections.value = sections.value.filter((x) => x !== s);
};
const addSection = (name: SectionName) => add(sections.value, blankSection(name), `#${props.idPrefix}-${name}`);
const tag = (x: { new?: true; from?: string }) => (x.new ? `New${x.from ? ` from ${x.from}` : ''}` : '');
</script>

<template>
  <div class="cv-doc">
    <section v-for="(s, si) in sections" :id="sid(s)" :key="s.name" class="cv-section" :aria-label="s.name">
      <header>
        <h2>{{ s.name }}</h2>
        <span v-if="editable" class="cv-tools">
          <button type="button" class="quiet" :aria-label="`Move the ${s.name} section up`" :disabled="si === 0" @click="move(sections, si, -1)">Up</button>
          <button type="button" class="quiet" :aria-label="`Move the ${s.name} section down`" :disabled="si === sections.length - 1" @click="move(sections, si, 1)">Down</button>
          <button type="button" class="quiet danger" :aria-label="`Remove the ${s.name} section`" @click="removeSection(s)">Remove section</button>
        </span>
      </header>

      <template v-if="isEntries(s)">
        <article v-for="(e, i) in s.entries" :key="key(e)" class="cv-entry" :class="{ 'is-new': e.new }" :aria-label="e.org || `New ${s.name} entry`">
          <div v-if="editable" class="cv-entry-head">
            <label>{{ ORG[s.name] ?? 'Employer' }}
              <input v-model="e.org" class="org" type="text" maxlength="120" :aria-invalid="!!(e.title || e.bullets.length > 1) && !e.org.trim()" />
            </label>
            <label>{{ s.name === 'Education' ? 'Degree' : 'Title' }} <input v-model="e.title" type="text" maxlength="120" /></label>
            <label>From <input v-model="e.start" type="text" maxlength="7" placeholder="2021-03" :aria-invalid="!!e.start && badStart(e)" /></label>
            <label>To <input v-model="e.end" type="text" maxlength="7" placeholder="present" :aria-invalid="!!e.end && badEnd(e)" /></label>
            <label>Where <input v-model="e.location" type="text" maxlength="120" /></label>
            <span class="cv-tools">
              <button type="button" class="quiet" :aria-label="`Move ${e.org || 'entry'} up`" :disabled="i === 0" @click="move(s.entries, i, -1)">Up</button>
              <button type="button" class="quiet" :aria-label="`Move ${e.org || 'entry'} down`" :disabled="i === s.entries.length - 1" @click="move(s.entries, i, 1)">Down</button>
              <button type="button" class="quiet danger" :aria-label="`Remove ${e.org || 'entry'}`" @click="drop(s.entries, i)">Remove</button>
            </span>
          </div>
          <header v-else class="cv-entry-read">
            <h3>{{ e.org }}<span v-if="e.title" class="entry-title"> · {{ e.title }}</span></h3>
            <p class="hint">{{ [[e.start, e.end].filter(Boolean).join(' – '), e.location].filter(Boolean).join(' · ') }}</p>
          </header>
          <p v-if="tag(e)" class="tag new">{{ tag(e) }}</p>
          <slot name="entry" :entry="e" />
          <ul class="lines cv-items">
            <li
              v-for="(b, j) in e.bullets" :key="key(b)" class="cv-item" :class="{ focused: b.id && b.id === focused, 'is-new': b.new }"
              @focusin="emit('focus', b)" @click="emit('focus', b)"
            >
              <textarea v-if="editable" v-model="b.text" rows="1" maxlength="2000" :aria-label="`${e.org || 'Entry'}, line ${j + 1}`" placeholder="What you did and what came of it"></textarea>
              <p v-else class="line-text" tabindex="0">{{ b.text }}</p>
              <span v-if="editable" class="cv-tools">
                <button type="button" class="quiet" :aria-label="`Move ${e.org || 'entry'} line ${j + 1} up`" :disabled="j === 0" @click="move(e.bullets, j, -1)">Up</button>
                <button type="button" class="quiet" :aria-label="`Move ${e.org || 'entry'} line ${j + 1} down`" :disabled="j === e.bullets.length - 1" @click="move(e.bullets, j, 1)">Down</button>
                <button type="button" class="quiet danger" :aria-label="`Remove ${e.org || 'entry'} line ${j + 1}`" @click="drop(e.bullets, j)">Remove</button>
              </span>
              <p v-if="tag(b)" class="line-meta"><span class="tag new">{{ tag(b) }}</span></p>
              <slot name="meta" :line="b" />
            </li>
          </ul>
          <button v-if="editable" type="button" class="quiet" @click="add(e.bullets, { text: '' }, `#${sid(s)} .cv-entry:nth-of-type(${i + 1}) .cv-items`)">Add line</button>
        </article>
        <p v-if="editable" class="add-row">
          <button type="button" @click="add(s.entries, blankEntry(), `#${sid(s)} .cv-entry:last-of-type .cv-entry-head label:first-child`)">{{ ADD_TEXT[s.name] }}</button>
        </p>
      </template>

      <template v-else>
        <ul class="lines">
          <li
            v-for="(b, j) in s.bullets" :key="key(b)" class="cv-item" :class="{ focused: b.id && b.id === focused, 'is-new': b.new }"
            @focusin="emit('focus', b)" @click="emit('focus', b)"
          >
            <textarea v-if="editable" v-model="b.text" rows="1" maxlength="2000" :aria-label="`${s.name}, line ${j + 1}`" :placeholder="PLACEHOLDER[s.name]"></textarea>
            <p v-else class="line-text" tabindex="0">{{ b.text }}</p>
            <span v-if="editable" class="cv-tools">
              <button type="button" class="quiet" :aria-label="`Move ${s.name} line ${j + 1} up`" :disabled="j === 0" @click="move(s.bullets, j, -1)">Up</button>
              <button type="button" class="quiet" :aria-label="`Move ${s.name} line ${j + 1} down`" :disabled="j === s.bullets.length - 1" @click="move(s.bullets, j, 1)">Down</button>
              <button type="button" class="quiet danger" :aria-label="`Remove ${s.name} line ${j + 1}`" @click="drop(s.bullets, j)">Remove</button>
            </span>
            <p v-if="tag(b)" class="line-meta"><span class="tag new">{{ tag(b) }}</span></p>
            <slot name="meta" :line="b" />
          </li>
        </ul>
        <p v-if="editable" class="add-row"><button type="button" class="quiet" @click="add(s.bullets, { text: '' }, `#${sid(s)} .lines`)">{{ ADD_TEXT[s.name] }}</button></p>
      </template>
    </section>

    <div v-if="editable && missing.length" class="add-row add-sections">
      <span class="hint">Add a section:</span>
      <button v-for="n in missing" :key="n" type="button" class="quiet" @click="addSection(n)">{{ n }}</button>
    </div>
  </div>
</template>
