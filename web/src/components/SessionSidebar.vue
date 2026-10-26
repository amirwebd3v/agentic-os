<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { SessionMode, SessionSummary } from '../api';
import { useAreasStore } from '../stores/areas';
import { useSessionsStore } from '../stores/sessions';

const sessions = useSessionsStore();
const areas = useAreasStore();
const router = useRouter();
const mode = ref<SessionMode>('chat');
const failed = ref<string | null>(null);

const groups = computed(() => {
  const byArea = new Map<number | null, SessionSummary[]>();
  for (const s of sessions.list) byArea.set(s.area_id, [...(byArea.get(s.area_id) ?? []), s]);
  return [...byArea].map(([id, list]) => {
    const area = areas.list.find((a) => a.id === id);
    const name = id === null ? 'Unfiled' : (area?.name ?? list[0]!.area_slug ?? `Area ${id}`);
    return { id, name: area?.status === 'proposed' ? `${name} (proposed)` : name, list };
  });
});

const run = async (what: string, fn: () => Promise<unknown>) => {
  failed.value = null;
  try {
    await fn();
  } catch {
    failed.value = `Couldn't ${what}.`;
  }
};
const create = () => run('create a session', async () => router.push(`/s/${(await sessions.create(mode.value)).id}`));
const refile = (id: number, e: Event) =>
  run('re-file the session', () => sessions.update(id, { area_id: Number((e.target as HTMLSelectElement).value) }));
</script>

<template>
  <nav class="sidebar" aria-label="Sessions">
    <div class="new">
      <label for="new-mode">Mode</label>
      <select id="new-mode" v-model="mode">
        <option value="chat">Chat</option>
        <option value="persona">Persona</option>
      </select>
      <button type="button" @click="create">New session</button>
    </div>
    <p v-if="failed" class="error" role="alert">{{ failed }}</p>
    <section v-for="g in groups" :key="String(g.id)">
      <h2>{{ g.name }}</h2>
      <ul>
        <li v-for="s in g.list" :key="s.id">
          <RouterLink :to="`/s/${s.id}`">{{ s.title ?? 'Untitled' }}</RouterLink>
          <span v-if="s.filing_status === 'flagged'" class="badge flagged" title="Filing flagged for review">
            <span aria-hidden="true">●</span><span class="sr-only">flagged</span>
          </span>
          <span v-else-if="s.filing_status" class="badge" :class="s.filing_status">{{ s.filing_status }}</span>
          <select
            v-if="sessions.current?.session.id === s.id"
            :aria-label="`File ${s.title ?? 'Untitled'} under area`"
            :value="s.area_id ?? ''"
            @change="refile(s.id, $event)"
          >
            <option value="" disabled>Choose area…</option>
            <option v-for="a in areas.list" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
        </li>
      </ul>
    </section>
    <RouterLink to="/review" class="review">Review</RouterLink>
  </nav>
</template>
