import { defineStore } from 'pinia';
import { ref } from 'vue';
import { batchApprovals, decideApproval, listApprovals, type Approval, type Decision } from '../api';

/** The review queue; `total` drives the nav badge. */
export const useReviewStore = defineStore('review', () => {
  const items = ref<Approval[]>([]);
  const more = ref(0);
  const total = ref(0);
  const showAll = ref(false);
  const load = async () => {
    const page = await listApprovals(showAll.value);
    items.value = page.items;
    more.value = page.more;
    total.value = page.total;
  };
  const decide = async (id: number, decision: Decision) => {
    try {
      await decideApproval(id, decision);
    } finally {
      await load(); // a stale conflict was refreshed server-side: show its new state
    }
  };
  /** Returns the error messages of the items that failed. */
  const batch = async (ids: number[], decision: Decision) => {
    try {
      const results = await batchApprovals(ids, decision);
      return results.filter((r) => !r.ok).map((r) => `#${r.id}: ${r.error}`);
    } finally {
      await load();
    }
  };
  return { items, more, total, showAll, load, decide, batch };
});
