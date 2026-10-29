<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError, type Decision } from '../api';
import ApprovalCard from '../components/ApprovalCard.vue';
import { useReviewStore } from '../stores/review';

const review = useReviewStore();
const selected = ref(new Set<number>());
const busy = ref(false);
const message = ref<string | null>(null);

const allSelected = computed(() => review.items.length > 0 && review.items.every((a) => selected.value.has(a.id)));
const toggle = (id: number, on: boolean) => (on ? selected.value.add(id) : selected.value.delete(id));
const toggleAll = () => (selected.value = allSelected.value ? new Set() : new Set(review.items.map((a) => a.id)));

const run = async (fn: () => Promise<string[] | void>) => {
  busy.value = true;
  message.value = null;
  try {
    const failures = await fn();
    if (failures?.length) message.value = `Some items couldn't be applied: ${failures.join('; ')}`;
  } catch (err) {
    message.value =
      err instanceof ApiError && err.detail && err.status < 500 ? `Couldn't apply that: ${err.detail}` : "Couldn't save the decision.";
  } finally {
    busy.value = false;
    selected.value = new Set([...selected.value].filter((id) => review.items.some((a) => a.id === id)));
  }
};
const decide = (id: number, decision: Decision) => run(() => review.decide(id, decision));
const batch = (decision: Decision) => run(() => review.batch([...selected.value], decision));
const showMore = () => {
  review.showAll = true;
  void run(review.load);
};

onMounted(() => {
  review.showAll = false; // the daily cap applies again on each visit
  void run(review.load);
});
</script>

<template>
  <main class="page review-queue">
    <h1>Review</h1>
    <div class="toolbar">
      <label><input type="checkbox" :checked="allSelected" :disabled="!review.items.length" @change="toggleAll" /> Select all</label>
      <button type="button" :disabled="busy || !selected.size" @click="batch('approve')">Approve selected ({{ selected.size }})</button>
      <button type="button" :disabled="busy || !selected.size" @click="batch('reject')">Reject selected ({{ selected.size }})</button>
    </div>
    <p v-if="message" class="error" role="alert">{{ message }}</p>
    <div v-if="!review.items.length && !review.more" class="placeholder">
      <p>Nothing to review. When the app proposes a change to your notes, it waits here for your yes or no.</p>
    </div>
    <p v-else-if="!review.items.length" class="placeholder">That's today's review done.</p>
    <ApprovalCard
      v-for="a in review.items"
      :key="a.id"
      :approval="a"
      :busy="busy"
      :selected="selected.has(a.id)"
      @update:selected="toggle(a.id, $event)"
      @decide="(d) => decide(a.id, d)"
    />
    <button v-if="review.more" type="button" class="more" :disabled="busy" @click="showMore">Show {{ review.more }} more</button>
  </main>
</template>
