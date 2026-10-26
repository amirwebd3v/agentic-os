import { defineStore } from 'pinia';
import { ref } from 'vue';
import { batchApprovals, decideApproval, listApprovals, type Approval, type Decision } from '../api';
import { useAreasStore } from './areas';
import { useSessionsStore } from './sessions';

/** The review queue; `total` drives the sidebar badge. */
export const useReviewStore = defineStore('review', () => {
  const items = ref<Approval[]>([]);
  const more = ref(0);
  const total = ref(0);
  const showAll = ref(false);
  // An approved area shows up in the sidebar and the re-file picker; re-filed sessions change too.
  const refreshOthers = () => Promise.allSettled([useAreasStore().load(), useSessionsStore().load()]);
  const load = async () => {
    const page = await listApprovals(showAll.value);
    items.value = page.items;
    more.value = page.more;
    total.value = page.total;
  };
  const decide = async (id: number, decision: Decision, finalText?: string) => {
    try {
      await decideApproval(id, decision, finalText);
      if (decision === 'approve') void refreshOthers();
    } finally {
      await load(); // a stale conflict was refreshed server-side: show its new state
    }
  };
  /** Returns the error messages of the items that failed. */
  const batch = async (ids: number[], decision: Decision) => {
    try {
      const results = await batchApprovals(ids, decision);
      if (decision === 'approve') void refreshOthers();
      return results.filter((r) => !r.ok).map((r) => `#${r.id}: ${r.error}`);
    } finally {
      await load();
    }
  };
  return { items, more, total, showAll, load, decide, batch };
});
