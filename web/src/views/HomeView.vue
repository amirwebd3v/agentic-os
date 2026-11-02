<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getDashboard, getMailAccounts, getMailOverview, listApplications, type ApplicationListItem, type ApplicationStatus, type Dashboard, type MailAccounts, type MailOverview } from '../api';
import BarChart from '../components/BarChart.vue';
import MailIdeas from '../components/MailIdeas.vue';
import { nextStep, today } from '../stores/career';
import { ago, plural } from '../mail';

// Home answers one question first: what needs me today, and is everything working? Then the figures and the
// agents' usage. Each source loads on its own, so one failing never hides the others. Counts and aggregates only,
// except the queue's company and role, which are the owner's own application names, and the mail ideas (text only).
const data = ref<Dashboard | null>(null);
const apps = ref<ApplicationListItem[] | null>(null);
const mailAccounts = ref<MailAccounts | null>(null);
const mailOverview = ref<MailOverview | null>(null);
const failed = ref({ dashboard: false, apps: false, mail: false });
const showAll = ref(false);

onMounted(() => {
  getDashboard().then((d) => (data.value = d), () => (failed.value.dashboard = true));
  listApplications().then((a) => (apps.value = a), () => (failed.value.apps = true));
  getMailAccounts()
    .then(async (a) => {
      mailAccounts.value = a;
      if (a.accounts.some((x) => x.status !== 'disconnected')) mailOverview.value = await getMailOverview();
    })
    .catch(() => (failed.value.mail = true));
});

const n = (x: number) => x.toLocaleString('en');
const tokens = (x: number) => (x >= 1_000_000 ? `${(x / 1_000_000).toFixed(1)}M` : x >= 1000 ? `${Math.round(x / 1000)}k` : String(x));
const usd = (x: number) => `$${x < 10 ? x.toFixed(2) : Math.round(x).toLocaleString('en')}`;
const day = (d: string) => new Date(`${d}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const dateLine = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

// ---- which sources have answered: nothing says "all clear" until every one has, or names the one that couldn't
const settled = computed(() => ({
  dashboard: !!data.value || failed.value.dashboard,
  apps: !!apps.value || failed.value.apps,
  mail: !!mailAccounts.value || failed.value.mail,
}));
const allSettled = computed(() => settled.value.dashboard && settled.value.apps && settled.value.mail);
const unchecked = computed(() => [failed.value.apps && 'your applications', failed.value.mail && 'your mail', failed.value.dashboard && 'Review and system'].filter(Boolean) as string[]);

// ---- the queue: everything that waits on the owner, across areas, most urgent first
type Item = { key: string; area: 'Career' | 'Email' | 'Review' | 'System'; title: string; detail: string; to: string; action: string; rank: number; due?: string };
const liveMail = computed(() => mailAccounts.value?.accounts.filter((a) => a.status !== 'disconnected') ?? []);
const queue = computed<Item[]>(() => {
  const items: Item[] = [];
  const d = today();
  for (const a of apps.value ?? []) {
    if (a.archived_at) continue;
    const step = nextStep(a, d);
    if (step.group !== 'needs' && step.group !== 'follow') continue;
    const urgent = a.status === 'failed' || a.fail_code === 'render_failed';
    items.push({ key: `a${a.id}`, area: 'Career', title: `${a.company} · ${a.role_title}`, detail: step.text, to: `/applications/${a.id}`, action: 'Open', rank: urgent ? 1 : step.group === 'needs' ? 3 : 4, ...(step.group === 'follow' && a.follow_up_on ? { due: a.follow_up_on } : {}) });
  }
  const reconnect = liveMail.value.filter((a) => a.status === 'reconnect');
  if (reconnect.length) items.push({ key: 'reconnect', area: 'Email', title: `${plural(reconnect.length, 'account needs', 'accounts need')} reconnecting`, detail: 'New mail from it is not read until you do', to: '/email', action: 'Reconnect', rank: 0 });
  if (liveMail.value.some((a) => a.triage_error === 'classifier_down')) items.push({ key: 'laya', area: 'Email', title: 'Sorting is paused', detail: 'The Laya classifier is down; start the app with pnpm dev', to: '/email', action: 'Details', rank: 1 });
  const sort = mailOverview.value?.needs_sorting ?? 0;
  if (sort) items.push({ key: 'sort', area: 'Email', title: `${plural(sort, 'mail')} to sort`, detail: 'Each sort teaches a rule after 3 mails from one sender', to: '/email', action: 'Sort', rank: 5 });
  const reviews = data.value?.system.approvals_pending ?? 0;
  if (reviews) items.push({ key: 'review', area: 'Review', title: `${plural(reviews, 'item')} waiting in Review`, detail: 'Proposed changes to your vault', to: '/review', action: 'Review', rank: 2 });
  if (data.value && data.value.system.provider !== 'ok')
    items.push({ key: 'provider', area: 'System', title: data.value.system.provider === 'error' ? 'The model provider rejects the key' : 'No model provider set up', detail: 'Check the key in .env (or pnpm secrets), then restart the app', to: '', action: '', rank: 0 });
  // Most urgent first; within a rank, the oldest-due follow-up first.
  return items.sort((x, y) => x.rank - y.rank || (x.due ?? '').localeCompare(y.due ?? ''));
});
/** The figure strip counts the same Career items the queue shows, so the two never disagree. */
const careerToDo = computed(() => queue.value.filter((i) => i.area === 'Career').length);
const QUEUE_SHOWN = 6;
const shownQueue = computed(() => (showAll.value ? queue.value : queue.value.slice(0, QUEUE_SHOWN)));

// ---- health: one row per moving part, a word and a dot each
type Health = { name: string; word: string; tone: 'ready' | 'attention' | 'danger' | ''; detail: string };
const health = computed<Health[]>(() => {
  const rows: Health[] = [];
  const s = data.value?.system;
  if (s) rows.push({ name: 'Claude provider', word: s.provider === 'ok' ? 'Working' : s.provider === 'error' ? 'Key rejected' : 'Not set up', tone: s.provider === 'ok' ? 'ready' : 'danger', detail: 'Drafts, letters and mail analysis' });
  const live = liveMail.value;
  if (!mailAccounts.value) {
    // Until the mail answers, "not connected" would be a guess that could hide a real problem.
    const word = failed.value.mail ? 'Unknown' : 'Checking…';
    const tone = failed.value.mail ? 'attention' : '';
    rows.push({ name: 'Laya classifier', word, tone, detail: failed.value.mail ? 'The mail summary didn’t load' : 'Sorts mail on this machine' });
    rows.push({ name: 'Gmail', word, tone, detail: failed.value.mail ? 'The mail summary didn’t load' : 'Read-only' });
  } else {
    const down = live.some((a) => a.triage_error === 'classifier_down');
    rows.push({ name: 'Laya classifier', word: !live.length ? 'Not used yet' : down ? 'Down' : 'Working', tone: !live.length ? '' : down ? 'attention' : 'ready', detail: 'Sorts mail on this machine' });
    const reconnect = live.filter((a) => a.status === 'reconnect').length;
    const synced = live.map((a) => a.last_synced_at).filter((x): x is string => !!x).sort().at(-1);
    rows.push({
      name: 'Gmail',
      word: !live.length ? 'Not connected' : reconnect ? `${reconnect} to reconnect` : 'Connected',
      tone: !live.length ? '' : reconnect ? 'danger' : 'ready',
      detail: live.length ? `${plural(live.length, 'account')}${synced ? ` · synced ${ago(synced)}` : ''}` : 'Read-only, when you connect it',
    });
  }
  rows.push({ name: 'Social and blog', word: 'Not connected', tone: '', detail: 'Drafts for posts come in a later slice' });
  if (s) {
    rows.push({ name: 'Jobs', word: s.jobs.failed_7d ? `${s.jobs.failed_7d} failed` : 'Running fine', tone: s.jobs.failed_7d ? 'attention' : 'ready', detail: `${s.jobs.queued + s.jobs.running} queued or running · last 7 days` });
    rows.push({ name: 'Vault', word: s.last_vault_commit ? 'Saved' : 'No commits yet', tone: s.last_vault_commit ? 'ready' : '', detail: `${n(s.vault_notes)} notes${s.last_vault_commit ? ` · last commit ${ago(s.last_vault_commit)}` : ''}` });
  }
  return rows;
});
const problems = computed(() => health.value.filter((h) => h.tone === 'danger' || h.tone === 'attention').length);

// ---- figures and charts
const ai = computed(() => data.value?.ai);
const STATUS_TEXT: Record<ApplicationStatus, string> = {
  processing: 'In progress', draft_ready: 'Ready for review', flagged: 'Needs your check', needs_answers: 'Waiting for your answers',
  failed: 'Failed', final: 'Final, not sent', applied: 'Applied', withdrawn: 'Withdrawn',
};
const statuses = computed(() =>
  (Object.keys(STATUS_TEXT) as ApplicationStatus[]).map((s) => ({ label: STATUS_TEXT[s], value: data.value?.areas.career.by_status[s] ?? 0 })).filter((r) => r.value),
);
const totalApps = computed(() => statuses.value.reduce((a, r) => a + r.value, 0));
const tokenDays = computed(() => (ai.value?.days ?? []).map((d) => ({ label: day(d.day), value: d.input_tokens + d.output_tokens, hint: `${n(d.calls)} calls${d.cost === null ? '' : `, ${usd(d.cost)}`}` })));
const pipelines = computed(() => [...(ai.value?.by_pipeline ?? [])].sort((a, b) => b.calls - a.calls).slice(0, 6).map((p) => ({ label: p.pipeline, value: p.calls })));
const failRate = computed(() => {
  const t = ai.value?.totals;
  return t && t.calls ? Math.round(((t.failures ?? 0) / t.calls) * 100) : 0;
});

/** The title row's sentence: what needs you, whether it all works, what it cost. */
const status = computed(() => {
  const parts: { text: string; tone?: string }[] = [];
  if (queue.value.length) parts.push({ text: `${plural(queue.value.length, 'thing needs', 'things need')} you`, tone: 'lead' });
  else if (allSettled.value) parts.push(unchecked.value.length ? { text: `Couldn't check ${unchecked.value.join(' or ')}`, tone: 'attention' } : { text: 'Nothing needs you' });
  if (problems.value) parts.push({ text: `${plural(problems.value, 'part needs', 'parts need')} attention`, tone: 'attention' });
  else if (allSettled.value && !unchecked.value.length) parts.push({ text: 'everything is working' });
  if (ai.value && ai.value.totals.cost !== null) parts.push({ text: `${usd(ai.value.totals.cost)} of AI in 30 days` });
  return parts;
});
</script>

<template>
  <main class="page home">
    <header class="home-head">
      <h1>Overview</h1>
      <p class="status-line">
        <span class="date">{{ dateLine }}</span>
        <template v-for="p in status" :key="p.text"><span class="sep" aria-hidden="true"> · </span><span :class="p.tone">{{ p.text }}</span></template>
      </p>
    </header>

    <p v-if="failed.dashboard" class="notice danger" role="alert">The usage and system figures didn't load. Is the server running?</p>

    <div class="board">
      <section class="block queue" aria-labelledby="queue-title">
        <header class="block-head">
          <h2 id="queue-title">Needs you</h2>
          <span v-if="queue.length" class="count">{{ queue.length }}</span>
        </header>
        <p v-if="unchecked.length" class="hint">Couldn't check {{ unchecked.join(' or ') }}, so this list may be short.</p>
        <ul v-if="queue.length" class="items">
          <li v-for="item in shownQueue" :key="item.key" class="item">
            <span class="area-tag">{{ item.area }}</span>
            <span class="what">
              <RouterLink v-if="item.to" :to="item.to" class="title" :title="item.title" :aria-describedby="`d-${item.key}`">{{ item.title }}</RouterLink>
              <span v-else class="title">{{ item.title }}</span>
              <span :id="`d-${item.key}`" class="detail">{{ item.detail }}</span>
            </span>
            <!-- The same destination as the title: one stop for keyboards and screen readers, a clear verb for the eye. -->
            <RouterLink v-if="item.action && item.to" :to="item.to" class="act" tabindex="-1" aria-hidden="true">{{ item.action }}</RouterLink>
          </li>
        </ul>
        <p v-else-if="!allSettled" class="hint" role="status">Checking…</p>
        <p v-else-if="!unchecked.length" class="calm">Nothing waits on you. New drafts, follow-ups and mail to sort appear here.</p>
        <button v-if="queue.length > QUEUE_SHOWN" type="button" class="quiet more" :aria-expanded="showAll" @click="showAll = !showAll">{{ showAll ? 'Show fewer' : `Show all ${queue.length}` }}</button>
      </section>

      <section class="block health" aria-labelledby="health-title">
        <header class="block-head"><h2 id="health-title">System health</h2></header>
        <ul class="items">
          <li v-for="h in health" :key="h.name" class="hrow">
            <span class="hname">{{ h.name }}</span>
            <span class="status" :class="h.tone">{{ h.word }}</span>
            <span class="detail">{{ h.detail }}</span>
          </li>
        </ul>
      </section>

      <section class="block strip" aria-label="Key figures">
        <dl>
          <div>
            <dt>Applications</dt>
            <dd>{{ data ? n(totalApps) : '–' }}</dd>
            <dd class="sub"><RouterLink to="/applications">{{ data ? `${apps ? careerToDo : data.areas.career.needs_you} to act on · ${data.areas.career.new_this_week} new this week` : 'View all' }}</RouterLink></dd>
          </div>
          <div>
            <dt>Mail sorted by you</dt>
            <dd>{{ mailOverview ? n(mailOverview.calibration.done) : '–' }}</dd>
            <dd class="sub"><RouterLink to="/email">{{ mailOverview ? `${n(mailOverview.needs_sorting)} to sort · ${mailOverview.rules.length} rules` : liveMail.length ? 'Open Email' : 'Connect Gmail' }}</RouterLink></dd>
          </div>
          <div>
            <dt>AI calls, 30 days</dt>
            <dd>{{ ai ? n(ai.totals.calls) : '–' }}</dd>
            <dd class="sub">{{ ai ? `${failRate}% failed · ${tokens(ai.totals.input_tokens + ai.totals.output_tokens)} tokens` : '' }}</dd>
          </div>
          <div>
            <dt>Estimated cost, 30 days</dt>
            <dd>{{ ai ? (ai.totals.cost === null ? 'Not priced' : usd(ai.totals.cost)) : '–' }}</dd>
            <dd class="sub">{{ ai ? (ai.priced ? 'From list prices' : 'Some models have no known price') : '' }}</dd>
          </div>
          <div>
            <dt>Master CV</dt>
            <dd>{{ data ? (data.areas.career.master.exists && data.areas.career.master.lines !== null ? n(data.areas.career.master.lines) : data.areas.career.master.exists ? '?' : '0') : '–' }}</dd>
            <dd class="sub"><RouterLink to="/cv">{{ data && data.areas.career.master.entries !== null ? `lines in ${data.areas.career.master.entries} entries` : 'Open the Master CV' }}</RouterLink></dd>
          </div>
        </dl>
      </section>

      <section class="block usage" aria-labelledby="usage-title">
        <header class="block-head">
          <h2 id="usage-title">AI usage</h2>
          <span class="hint">Tokens per day, last 30 days</span>
        </header>
        <BarChart v-if="ai && ai.totals.calls" :data="tokenDays" title="Tokens per day" :format="tokens" :height="226" />
        <p v-else class="calm">{{ ai ? 'No model calls yet. Your first application or mail analysis shows up here.' : '' }}</p>
      </section>

      <div class="side">
        <section class="block calls" aria-labelledby="calls-title">
          <header class="block-head"><h2 id="calls-title">Calls by step</h2></header>
          <BarChart v-if="pipelines.length" :data="pipelines" title="Calls" horizontal />
          <p v-else class="calm">Nothing yet.</p>
        </section>
        <section class="block pipeline" aria-labelledby="pipeline-title">
          <header class="block-head">
            <h2 id="pipeline-title">Applications</h2>
            <RouterLink to="/applications" class="hint">View all</RouterLink>
          </header>
          <BarChart v-if="statuses.length" :data="statuses" title="Applications by status" horizontal />
          <p v-else class="calm">No applications yet. <RouterLink to="/new">Start one</RouterLink></p>
        </section>
      </div>

      <div class="ideas-slot">
        <MailIdeas v-if="mailOverview" :overview="mailOverview" />
        <section v-else class="block" aria-labelledby="ideas-empty">
          <header class="block-head"><h2 id="ideas-empty">Ideas from your mail</h2></header>
          <p class="calm">{{ failed.mail ? 'Your mail summary didn’t load.' : 'Connect Gmail in Email, and each idea category gets a weekly paragraph here.' }}</p>
        </section>
      </div>
    </div>
  </main>
</template>

<style scoped>
.home-head { margin-bottom: var(--s5); }
.home-head h1 { margin-bottom: var(--s1); }
.status-line { margin: 0; color: var(--muted); font-variant-numeric: tabular-nums; }
.status-line .lead { color: var(--fg); font-weight: 600; }
.status-line .attention { color: var(--fg); font-weight: 600; background: var(--attention-tint); padding: 0 6px; border-radius: 4px; }

/*
 * 12 columns, one 16px gutter both ways. Rows, each summing to 12 and ending level:
 * queue 8 + health 4 · figures 12 · usage 8 + (calls over applications) 4 · ideas 12.
 */
.board { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--s4); align-items: start; }
.block { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s4) var(--s5); min-width: 0; }
.queue { grid-column: span 8; align-self: stretch; }
.health { grid-column: span 4; align-self: stretch; }
.strip { grid-column: span 12; padding: 0; }
.usage { grid-column: span 8; align-self: stretch; }
.side { grid-column: span 4; display: grid; gap: var(--s4); align-content: start; }
.ideas-slot { grid-column: span 12; }
.ideas-slot :deep(.panel) { margin: 0; border-radius: var(--radius); }

.block-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s3); margin-bottom: var(--s3); }
.block-head h2 { font-family: var(--sans); font-size: 15px; line-height: 22px; font-weight: 600; letter-spacing: 0; margin: 0; }
.count { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--fg); }
.calm { color: var(--muted); margin: 0; }
.items { list-style: none; margin: 0; padding: 0; }

.item { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr) auto; gap: var(--s3); align-items: center; padding: var(--s2) 0; border-top: 1px solid var(--border); }
.item:first-child { border-top: 0; padding-top: 0; }
.area-tag { font-size: 12.5px; line-height: 20px; color: var(--muted); }
.what { min-width: 0; display: grid; }
.title { color: var(--fg); font-weight: 600; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.title:hover { text-decoration: underline; }
.detail { font-size: 13px; line-height: 19px; color: var(--muted); }
.act { font-size: 13.5px; font-weight: 550; color: var(--fg); text-decoration: none; border: 1px solid var(--border-strong); border-radius: 999px; padding: 3px 12px; white-space: nowrap; }
.act:hover { background: var(--inset); }
.more { padding-left: 0; margin-top: var(--s2); }

.hrow { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: var(--s2); padding: var(--s2) 0; border-top: 1px solid var(--border); }
.hrow:first-child { border-top: 0; padding-top: 0; }
.hname { font-weight: 550; }
.hrow .detail { grid-column: 1 / -1; }

.strip dl { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); margin: 0; }
.strip dl > div { padding: var(--s4) var(--s5); border-left: 1px solid var(--border); display: flex; flex-direction: column; }
.strip dl > div:first-child { border-left: 0; }
.strip dt { font-size: 13px; line-height: 18px; color: var(--muted); }
.strip dd { margin: var(--s1) 0; font-family: var(--serif); font-size: 30px; line-height: 36px; font-variant-numeric: tabular-nums; }
.strip dd.sub { margin: 0; font-size: 13px; line-height: 19px; color: var(--muted); }
.strip .sub a { color: var(--muted); }
.strip .sub a:hover { color: var(--fg); }

@media (max-width: 1100px) {
  .queue, .usage, .ideas-slot, .health { grid-column: span 12; }
  .side { grid-column: span 12; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .strip dl { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .strip dl > div:nth-child(4) { border-left: 0; }
  .strip dl > div:nth-child(n + 4) { border-top: 1px solid var(--border); }
}
@media (max-width: 720px) {
  .side { grid-template-columns: minmax(0, 1fr); }
  .strip dl { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .strip dl > div { border-left: 0; border-top: 1px solid var(--border); }
  .strip dl > div:nth-child(even) { border-left: 1px solid var(--border); }
  .strip dl > div:nth-child(-n + 2) { border-top: 0; }
  .item { grid-template-columns: minmax(0, 1fr) auto; }
  .area-tag { grid-column: 1 / -1; }
}
</style>
