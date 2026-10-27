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
    You're not logged in. Open the login link printed by the server, or run <code>pnpm login-url</code>.
  </div>
  <template v-else>
    <ProviderBanner />
    <div class="layout">
      <AppNav />
      <RouterView :key="$route.fullPath" />
    </div>
  </template>
</template>
