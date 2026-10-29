<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getDashboard, type ApplicationStatus, type Dashboard } from '../api';
import BarChart from '../components/BarChart.vue';

// The OS overview: how the agents work (usage, cost, failures), the state of the system, and each area at a glance.
// Only counts and aggregates reach this page.
const data = ref<Dashboard | null>(null);
const error = ref<string | null>(null);

const hour = new Date().getHours();
const greeting = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
const n = (x: number) => x.toLocaleString('en');
const tokens = (x: number) => (x >= 1_000_000 ? `${(x / 1_000_000).toFixed(1)}M` : x >= 1000 ? `${Math.round(x / 1000)}k` : String(x));
const usd = (x: number) => `$${x < 10 ? x.toFixed(2) : Math.round(x).toLocaleString('en')}`;
const day = (d: string) => new Date(`${d}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const ago = (iso: string) => {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return min < 60 ? `${min} min ago` : min < 1440 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};

const ai = computed(() => data.value?.ai);
const tokenDays = computed(() => (ai.value?.days ?? []).map((d) => ({ label: day(d.day), value: d.input_tokens + d.output_tokens, hint: `${n(d.calls)} calls${d.failures ? `, ${d.failures} failed` : ''}` })));
const pipelines = computed(() => [...(ai.value?.by_pipeline ?? [])].sort((a, b) => b.calls - a.calls).map((p) => ({ label: p.pipeline, value: p.calls })));
const failRate = computed(() => {
  const t = ai.value?.totals;
  return t && t.calls ? Math.round(((t.failures ?? 0) / t.calls) * 100) : 0;
});

const STATUS_TEXT: Record<ApplicationStatus, string> = {
  processing: 'In progress', draft_ready: 'Ready for review', flagged: 'Needs your check', needs_answers: 'Waiting for your answers',
  failed: 'Failed', final: 'Final, not sent', applied: 'Applied', withdrawn: 'Withdrawn',
};
const career = computed(() => data.value?.areas.career);
const statuses = computed(() =>
  (Object.keys(STATUS_TEXT) as ApplicationStatus[]).map((s) => ({ label: STATUS_TEXT[s], value: career.value?.by_status[s] ?? 0 })).filter((r) => r.value),
);
const total = computed(() => statuses.value.reduce((a, r) => a + r.value, 0));

onMounted(() => getDashboard().then((d) => (data.value = d), () => (error.value = "Couldn't load the overview. Is the server running?")));
</script>

<template>
  <main class="page home">
    <header class="page-head">
      <h1>{{ greeting }}</h1>
      <p class="lede">How your agents are doing, what they cost, and where each area of your life stands.</p>
    </header>
    <p v-if="error" class="notice danger" role="alert">{{ error }}</p>
    <p v-else-if="!data" class="placeholder" role="status">Loading…</p>

    <template v-else>
      <section class="dash-areas" aria-label="Areas">
        <RouterLink to="/applications" class="area">
          <h2>Career</h2>
          <p class="big">{{ career!.needs_you }} <span>{{ career!.needs_you === 1 ? 'needs' : 'need' }} you</span></p>
          <p class="hint">{{ total }} applications · {{ career!.new_this_week }} new this week<template v-if="career!.archived"> · {{ career!.archived }} archived</template></p>
        </RouterLink>
        <RouterLink to="/cv" class="area">
          <h2>Master CV</h2>
          <p v-if="career!.master.exists && career!.master.lines !== null" class="big">{{ n(career!.master.lines) }} <span>lines</span></p>
          <p v-else-if="career!.master.exists" class="big"><span>Can't be read</span></p>
          <p v-else class="big">None <span>yet</span></p>
          <p class="hint">{{ career!.master.entries !== null && career!.master.exists ? `${career!.master.entries} ${career!.master.entries === 1 ? 'entry' : 'entries'}, from all your CVs` : career!.master.exists ? 'Fix it on the Master CV page' : 'Import your Word CVs to start' }}</p>
        </RouterLink>
        <div class="area off">
          <h2>Email</h2>
          <p class="big"><span>Not connected</span></p>
          <p class="hint">Triage and draft replies come with the email slice.</p>
        </div>
        <div class="area off">
          <h2>Social and blog</h2>
          <p class="big"><span>Not connected</span></p>
          <p class="hint">Drafts for posts come later.</p>
        </div>
      </section>

      <section class="dash-grid" aria-labelledby="ai-title">
        <div class="panel wide">
          <header class="spread">
            <h2 id="ai-title">AI usage, last 30 days</h2>
            <p class="hint">{{ ai!.priced ? 'Cost is an estimate from list prices' : 'Some models have no known price' }}</p>
          </header>
          <dl class="figures">
            <div><dt>Calls</dt><dd>{{ n(ai!.totals.calls) }}</dd></div>
            <div><dt>Tokens</dt><dd>{{ tokens(ai!.totals.input_tokens + ai!.totals.output_tokens) }}</dd></div>
            <div><dt>Estimated cost</dt><dd>{{ ai!.totals.cost === null ? 'Not priced' : usd(ai!.totals.cost) }}</dd></div>
            <div><dt>Failed</dt><dd>{{ failRate }}%</dd></div>
          </dl>
          <BarChart v-if="ai!.totals.calls" :data="tokenDays" title="Tokens per day" :format="tokens" />
          <p v-else class="hint">No model calls yet.</p>
        </div>
        <div class="panel">
          <h2>Calls by step</h2>
          <BarChart v-if="pipelines.length" :data="pipelines" title="Calls" horizontal />
          <p v-else class="hint">Nothing yet.</p>
        </div>
        <div class="panel">
          <h2>Applications by status</h2>
          <BarChart v-if="statuses.length" :data="statuses" title="Applications" horizontal />
          <p v-else class="hint">No applications yet. <RouterLink to="/new">Start one</RouterLink></p>
        </div>
        <div class="panel">
          <h2>System</h2>
          <dl class="facts">
            <dt>Model provider</dt><dd :class="{ error: data.system.provider !== 'ok' }">{{ data.system.provider === 'ok' ? 'Connected' : data.system.provider === 'error' ? 'Key rejected' : 'Not set up' }}</dd>
            <dt>Waiting in Review</dt><dd><RouterLink v-if="data.system.approvals_pending" to="/review">{{ data.system.approvals_pending }}</RouterLink><template v-else>0</template></dd>
            <dt>Jobs queued or running</dt><dd>{{ data.system.jobs.queued + data.system.jobs.running }}</dd>
            <dt>Jobs failed, 7 days</dt><dd :class="{ error: data.system.jobs.failed_7d }">{{ data.system.jobs.failed_7d }}</dd>
            <dt>Notes in your vault</dt><dd>{{ n(data.system.vault_notes) }}</dd>
            <dt>Last vault commit</dt><dd>{{ data.system.last_vault_commit ? ago(data.system.last_vault_commit) : 'None yet' }}</dd>
          </dl>
        </div>
      </section>
    </template>
  </main>
</template>
