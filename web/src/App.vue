<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { checkSession, needsLogin } from './api';
import { useProviderStore } from './stores/provider';
import { useReviewStore } from './stores/review';
import AppNav from './components/AppNav.vue';
import ProviderBanner from './components/ProviderBanner.vue';

const provider = useProviderStore();
const review = useReviewStore();

// Checked first, so a logged-out start shows the login help without a failed request. A later 401 also sets needsLogin;
// any other failure just leaves that part empty.
const ready = ref(false);
onMounted(async () => {
  if (await checkSession()) void Promise.allSettled([provider.load(), review.load()]);
  ready.value = true;
});
</script>

<template>
  <div v-if="needsLogin" class="login" role="alert">
    <p><strong>You're not logged in.</strong></p>
    <p>Open the login link the server printed when it started, or run <code>pnpm login-url</code> for a new one.</p>
  </div>
  <template v-else-if="ready">
    <ProviderBanner />
    <AppNav />
    <RouterView :key="$route.path" />
  </template>
</template>
