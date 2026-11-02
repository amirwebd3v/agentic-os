<script setup lang="ts">
import { computed, ref } from 'vue';
import { saveIdea } from '../api';
import type { MailCategory, MailOverview } from '../api';
import { paragraphMeta } from '../mail';

// Home's ideas panel (D6): one paragraph per idea category, set as reading text. Model text from strangers' mail,
// rendered with {{ }} only.
const props = defineProps<{ overview: MailOverview }>();

const ideas = computed(() => props.overview.categories.filter((c) => c.system === null));
const written = computed(() => ideas.value.filter((c) => c.paragraph));
const quiet = computed(() => ideas.value.filter((c) => !c.paragraph));
const saved = ref<Record<number, string>>({});
const saving = ref<number | null>(null);

async function save(c: MailCategory) {
  saving.value = c.id;
  try {
    const out = await saveIdea(c.id);
    saved.value = { ...saved.value, [c.id]: out.saved ? `Saved to ${out.path}` : 'Already in your vault' };
  } catch {
    saved.value = { ...saved.value, [c.id]: 'Could not save. Try again.' };
  } finally {
    saving.value = null;
  }
}
</script>

<template>
  <section class="panel ideas" aria-labelledby="ideas-title">
    <header class="spread">
      <h2 id="ideas-title">Ideas from your mail</h2>
      <RouterLink to="/email">Open Email</RouterLink>
    </header>

    <p v-if="!overview.consent" class="hint">Claude analysis is off, so no paragraphs are written. Turn it on in Email to get one per category.</p>
    <p v-else-if="!written.length" class="hint">{{ ideas.some((c) => c.refreshing) ? 'Writing this week’s paragraphs…' : 'No paragraphs yet. They are written the first time you open Email or Home each day, from the last 7 days of mail.' }}</p>

    <ul v-if="written.length" class="idea-grid">
      <li v-for="c in written" :key="c.id" class="idea">
        <h3><RouterLink :to="{ path: '/email', query: { view: String(c.id) } }">{{ c.name }}</RouterLink></h3>
        <p class="reading">{{ c.paragraph!.text }}</p>
        <p class="hint">
          {{ paragraphMeta(c.paragraph!) }}<template v-if="c.paragraph!.refresh_failed"> · the last refresh failed</template><template v-if="c.paragraph!.source_removed"> · a source was removed</template>
        </p>
        <div class="row">
          <button type="button" class="quiet" :disabled="saving === c.id" @click="save(c)">Save idea</button>
          <span v-if="saved[c.id]" class="hint" role="status">{{ saved[c.id] }}</span>
        </div>
      </li>
    </ul>

    <p v-if="written.length && quiet.length" class="hint quiet-list">
      Nothing new this week in {{ quiet.map((c) => c.name).join(', ') }}.
    </p>
  </section>
</template>

<style scoped>
.ideas { margin-bottom: var(--s3); }
.ideas header { margin-bottom: var(--s4); }
.idea-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr)); gap: var(--s5) var(--s6); }
.idea h3 { font-family: var(--sans); font-size: 13px; line-height: 18px; font-weight: 600; margin: 0 0 var(--s2); }
.idea h3 a { color: var(--muted); text-decoration: none; }
.idea h3 a:hover { color: var(--fg); text-decoration: underline; }
.reading { font-family: var(--serif); font-size: 18px; line-height: 28px; margin: 0 0 var(--s2); max-width: var(--measure); font-optical-sizing: auto; }
.idea .hint { margin: 0; }
.idea .row { margin-top: var(--s1); }
.idea .quiet { padding-left: 0; }
.quiet-list { margin: var(--s5) 0 0; }
</style>
