import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getProvider, reloadProvider, type Provider } from '../api';

export const useProviderStore = defineStore('provider', () => {
  const info = ref<Provider | null>(null);
  const load = async () => {
    info.value = await getProvider();
  };
  const reload = async () => {
    info.value = await reloadProvider();
  };
  return { info, load, reload };
});
