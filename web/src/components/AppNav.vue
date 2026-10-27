<script setup lang="ts">
import { useReviewStore } from '../stores/review';

const review = useReviewStore();
</script>

<template>
  <nav class="sidebar" aria-label="Main">
    <strong class="brand">Agentic OS</strong>
    <RouterLink to="/review">
      Review
      <span v-if="review.total" class="badge count">{{ review.total }}<span class="sr-only"> pending</span></span>
    </RouterLink>
  </nav>
</template>
