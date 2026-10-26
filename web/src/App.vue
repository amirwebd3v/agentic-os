<script setup lang="ts">
import { onMounted } from 'vue';
import { needsLogin } from './api';
import { useAreasStore } from './stores/areas';
import { useProviderStore } from './stores/provider';
import { useReviewStore } from './stores/review';
import { useSessionsStore } from './stores/sessions';
import ProviderBanner from './components/ProviderBanner.vue';
import SessionSidebar from './components/SessionSidebar.vue';

const provider = useProviderStore();
const areas = useAreasStore();
const sessions = useSessionsStore();
const review = useReviewStore();

// A 401 sets needsLogin; any other failure just leaves that part empty.
onMounted(() => Promise.allSettled([provider.load(), areas.load(), sessions.load(), review.load()]));
</script>

<template>
  <div v-if="needsLogin" class="login" role="alert">
    You're not logged in. Open the login link printed by the server, or run <code>pnpm login-url</code>.
  </div>
  <template v-else>
    <ProviderBanner />
    <div class="layout">
      <SessionSidebar />
      <RouterView :key="$route.fullPath" />
    </div>
  </template>
</template>
