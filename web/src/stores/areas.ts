import { defineStore } from 'pinia';
import { ref } from 'vue';
import { listAreas, type Area } from '../api';

export const useAreasStore = defineStore('areas', () => {
  const list = ref<Area[]>([]);
  const load = async () => {
    list.value = await listAreas();
  };
  return { list, load };
});
