<script setup lang="ts">
import { computed, ref } from 'vue';

// One series, one hue (the accent): bars for a magnitude over days (columns) or over categories (rows).
// Values are aggregates from the server, never personal text. Each column has an aria-label with its value; rows show it as text.
type Bar = { label: string; value: number | null; hint?: string };
const props = withDefaults(defineProps<{ data: Bar[]; title: string; format?: (n: number) => string; horizontal?: boolean; height?: number }>(), {
  format: (n: number) => n.toLocaleString('en'), horizontal: false, height: 140,
});
const max = computed(() => Math.max(1, ...props.data.map((d) => d.value ?? 0)));
const pct = (v: number | null) => `${((v ?? 0) / max.value) * 100}%`;
const hover = ref<number | null>(null);
const shown = computed(() => (hover.value === null ? null : props.data[hover.value] ?? null));
const ticks = computed(() => (props.data.length > 10 ? [0, Math.floor(props.data.length / 2), props.data.length - 1] : props.data.map((_, i) => i)));
</script>

<template>
  <figure class="chart" :aria-label="title">
    <div v-if="!horizontal" class="cols" :style="{ height: `${height}px` }" @mouseleave="hover = null">
      <span
        v-for="(d, i) in data" :key="d.label" class="col" :class="{ on: hover === i }" tabindex="0"
        :aria-label="`${d.label}: ${d.value === null ? 'not known' : format(d.value)}`"
        @mouseenter="hover = i" @focus="hover = i" @blur="hover = null"
      ><i :style="{ height: d.value ? `max(2px, ${pct(d.value)})` : '0' }"></i></span>
      <p v-if="shown" class="tip" role="status">{{ shown.label }} · <strong>{{ shown.value === null ? 'not known' : format(shown.value) }}</strong><template v-if="shown.hint"> · {{ shown.hint }}</template></p>
    </div>
    <div v-if="!horizontal" class="col-axis" aria-hidden="true">
      <span v-for="i in ticks" :key="i" :style="{ left: `${((i + 0.5) / data.length) * 100}%` }">{{ data[i]?.label }}</span>
    </div>
    <ul v-else class="rowbars">
      <li v-for="d in data" :key="d.label">
        <span class="name">{{ d.label }}</span>
        <span class="track"><i :style="{ width: d.value ? `max(3px, ${pct(d.value)})` : '0' }"></i></span>
        <span class="val">{{ d.value === null ? '—' : format(d.value) }}</span>
      </li>
    </ul>
  </figure>
</template>
