<script setup lang="ts">
import { onMounted } from 'vue';
import { needsLogin } from './api';
import { useProviderStore } from './stores/provider';
import { useReviewStore } from './stores/review';
import AppNav from './components/AppNav.vue';
import ProviderBanner from './components/ProviderBanner.vue';

const provider = useProviderStore();
const review = useReviewStore();

// A 401 sets needsLogin; any other failure just leaves that part empty.
onMounted(() => Promise.allSettled([provider.load(), review.load()]));
</script>

<template>
  <div v-if="needsLogin" class="login" role="alert">
    <p><strong>You're not logged in.</strong></p>
    <p>Open the login link the server printed when it started, or run <code>pnpm login-url</code> for a new one.</p>
  </div>
  <template v-else>
    <ProviderBanner />
    <AppNav />
    <RouterView :key="$route.path" />
  </template>
</template>
