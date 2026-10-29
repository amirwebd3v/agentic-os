<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { addMilestone, ApiError, getMaster, rerenderApplication, retryApplication, setFollowUp, type ApplicationListItem } from '../api';
import { nextStep, statusLabel, today, useCareerStore, type Group } from '../stores/career';
import { useReviewStore } from '../stores/review';

// Company and role are model or owner text: rendered with {{ }} only.
const career = useCareerStore();
const review = useReviewStore();
const loaded = ref(false);
const error = ref<string | null>(null);
const busy = ref<number | null>(null);
const hasMaster = ref<boolean | null>(null);

const hour = new Date().getHours();
const greeting = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';

const rows = computed(() =>
  career.list.filter((a) => !a.archived_at).map((a) => ({ a, step: nextStep(a), label: statusLabel(a) })),
);
const group = (g: Group) => rows.value.filter((r) => r.step.group === g);
const needs = computed(() => group('needs'));
const follow = computed(() => group('follow'));
const progress = computed(() => group('progress'));
const done = computed(() => group('done').slice(0, 6));
const waiting = computed(() => needs.value.length + follow.value.length + (review.total ? 1 : 0));
const words = ['Nothing', 'One thing', 'Two things', 'Three things', 'Four things', 'Five things'];
const lede = computed(() => {
  if (!loaded.value) return '';
  if (!waiting.value) return progress.value.length ? 'Nothing needs you right now. The app is working on the rest.' : 'Nothing needs you right now.';
  return `${words[waiting.value] ?? `${waiting.value} things`} ${waiting.value === 1 ? 'needs' : 'need'} you.`;
});

const title = (a: ApplicationListItem) => a.role_title ?? `Application ${a.id}`;
async function act(a: ApplicationListItem, fn: () => Promise<unknown>) {
  busy.value = a.id;
  error.value = null;
  try {
    await fn();
    await career.load();
  } catch (err) {
    const code = err instanceof ApiError ? err.detail : undefined;
    error.value =
      code === 'master_missing' ? 'There is no master CV yet. Add one on the Master CV page first.'
      : code === 'provider_not_configured' ? 'Connect a provider first (see the banner at the top).'
      : code === 'bad_date' ? 'That is not a valid date.'
      : `That didn't work for “${title(a)}”. Reload and try again.`;
  } finally {
    busy.value = null;
  }
}
const markApplied = (a: ApplicationListItem) => act(a, () => addMilestone(a.id, { kind: 'applied', on_date: today(), note: '' }));
const retry = (a: ApplicationListItem) => act(a, () => retryApplication(a.id));
const rerender = (a: ApplicationListItem) => act(a, () => rerenderApplication(a.id));
const followUp = (a: ApplicationListItem, date: string | null) => act(a, () => setFollowUp(a.id, date || null));
const inDays = (n: number) => today(new Date(Date.now() + n * 86_400_000));

onMounted(() => {
  void getMaster().then((m) => (hasMaster.value = m.exists), () => (hasMaster.value = null));
  career
    .load()
    .catch(() => (error.value = "Couldn't load your applications. Is the server running?"))
    .finally(() => (loaded.value = true));
});
</script>

<template>
  <main class="page home">
    <header class="home-head">
      <div>
        <h1>{{ greeting }}</h1>
        <p class="lede" aria-live="polite">{{ lede }}</p>
      </div>
      <RouterLink v-slot="{ navigate }" to="/new" custom>
        <button type="button" class="primary" @click="navigate">Tailor a CV for a job</button>
      </RouterLink>
    </header>
    <p v-if="error" class="notice danger" role="alert">{{ error }}</p>

    <section v-if="hasMaster === false" class="notice" aria-labelledby="start-title">
      <h2 id="start-title">Start with your master CV</h2>
      <p>Every line the app drafts cites a line of your master CV, so that comes first. Write it on the Master CV page, or import the CV or LinkedIn export you already have.</p>
      <RouterLink to="/cv">Set up your master CV</RouterLink>
    </section>

    <section class="group" aria-labelledby="needs-title">
      <h2 id="needs-title">Needs you <span v-if="loaded" class="hint">{{ needs.length + (review.total ? 1 : 0) || 'Nothing' }}</span></h2>
      <ul v-if="needs.length || review.total" class="rows">
        <li v-for="{ a, step, label } in needs" :key="a.id">
          <div class="who">
            <RouterLink :to="`/applications/${a.id}`">{{ title(a) }}</RouterLink>
            <span class="hint">{{ a.company ?? 'Company not known yet' }} · {{ step.text }}</span>
          </div>
          <span class="status" :class="label.tone">{{ label.text }}</span>
          <span class="next">
            <button v-if="a.status === 'failed'" type="button" :disabled="busy === a.id" @click="retry(a)">Retry</button>
            <button v-else-if="a.fail_code === 'render_failed'" type="button" :disabled="busy === a.id" @click="rerender(a)">Create files</button>
            <button v-else-if="a.status === 'final'" type="button" :disabled="busy === a.id" @click="markApplied(a)">Mark applied today</button>
            <RouterLink v-else :to="`/applications/${a.id}`">Open draft</RouterLink>
          </span>
        </li>
        <li v-if="review.total">
          <div class="who">
            <RouterLink to="/review">{{ review.total === 1 ? 'One item' : `${review.total} items` }} to review</RouterLink>
            <span class="hint">Changes the app proposes to your notes wait for your yes or no.</span>
          </div>
          <span></span>
          <span class="next"><RouterLink to="/review">Review</RouterLink></span>
        </li>
      </ul>
      <p v-else-if="loaded" class="hint">You're clear. Paste a job posting to start the next application.</p>
    </section>

    <section v-if="follow.length" class="group" aria-labelledby="follow-title">
      <h2 id="follow-title">Follow-ups due <span class="hint">{{ follow.length }}</span></h2>
      <ul class="rows">
        <li v-for="{ a, step } in follow" :key="a.id">
          <div class="who">
            <RouterLink :to="`/applications/${a.id}`">{{ title(a) }}</RouterLink>
            <span class="hint">{{ a.company ?? '' }} · {{ step.text }}</span>
          </div>
          <span></span>
          <span class="next">
            <button type="button" :disabled="busy === a.id" @click="followUp(a, inDays(7))">In a week</button>
            <button type="button" class="quiet" :disabled="busy === a.id" @click="followUp(a, null)">Done</button>
          </span>
        </li>
      </ul>
    </section>

    <section v-if="progress.length" class="group" aria-labelledby="progress-title">
      <h2 id="progress-title">In progress <span class="hint">{{ progress.length }}</span></h2>
      <ul class="rows">
        <li v-for="{ a, label } in progress" :key="a.id">
          <div class="who">
            <RouterLink :to="`/applications/${a.id}`">{{ title(a) }}</RouterLink>
            <span class="hint">{{ a.company ?? 'Reading the posting' }}</span>
          </div>
          <span class="status" :class="label.tone">{{ label.text }}</span>
          <span></span>
        </li>
      </ul>
    </section>

    <section v-if="done.length" class="group" aria-labelledby="done-title">
      <h2 id="done-title">Sent <span class="hint"><RouterLink to="/applications?status=done">All applications</RouterLink></span></h2>
      <ul class="rows">
        <li v-for="{ a, step, label } in done" :key="a.id">
          <div class="who">
            <RouterLink :to="`/applications/${a.id}`">{{ title(a) }}</RouterLink>
            <span class="hint">{{ a.company ?? '' }} · {{ step.text }}</span>
          </div>
          <span class="status" :class="label.tone">{{ label.text }}</span>
          <span class="next">
            <label v-if="a.status === 'applied'" class="hint">
              <span class="sr-only">Follow up on</span>
              <input
                type="date" :value="a.follow_up_on ?? ''" :aria-label="`Follow up on ${title(a)}`" :disabled="busy === a.id"
                @change="followUp(a, ($event.target as HTMLInputElement).value)"
              />
            </label>
          </span>
        </li>
      </ul>
    </section>

    <section class="group" aria-labelledby="sources-title">
      <h2 id="sources-title">Other areas</h2>
      <ul class="rows quiet">
        <li><span>Email</span><span class="hint">Not connected yet</span></li>
        <li><span>Social and blog</span><span class="hint">Not connected yet</span></li>
      </ul>
    </section>
  </main>
</template>
