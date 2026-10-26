<script setup lang="ts">
import { ref } from 'vue';
import { useProviderStore } from '../stores/provider';

const provider = useProviderStore();
const busy = ref(false);

async function reload() {
  busy.value = true;
  try {
    await provider.reload();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="provider.info && provider.info.status !== 'ok'" class="banner" role="status">
    <p v-if="provider.info.status === 'not_configured'">
      <strong>Connect a provider.</strong> Set <code>ANTHROPIC_API_KEY</code> (and <code>ANTHROPIC_BASE_URL</code>
      if needed) in the repo's <code>.env</code>, or run <code>pnpm secrets set anthropic</code>, then Reload.
    </p>
    <p v-else>
      <strong>The provider rejected the key.</strong> Fix <code>ANTHROPIC_API_KEY</code> in <code>.env</code>, then
      Reload.
    </p>
    <button type="button" :disabled="busy" @click="reload">Reload</button>
  </div>
</template>
