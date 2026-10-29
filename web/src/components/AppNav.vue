<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useKeys } from '../keys';
import { useReviewStore } from '../stores/review';

const review = useReviewStore();
const route = useRoute();
const router = useRouter();
const help = ref<HTMLDialogElement>();

// `g` then a letter jumps to a page; the second key must follow within a second.
let go = 0;
const GO: Record<string, string> = { h: '/', a: '/applications', c: '/cv', r: '/review' };
const jump = (key: string) => {
  if (Date.now() - go > 1000 || !GO[key]) return false;
  go = 0;
  void router.push(GO[key]);
  return true;
};
useKeys({
  g: () => (go = Date.now()),
  ...Object.fromEntries(Object.keys(GO).map((k) => [k, () => jump(k)])),
  n: () => void router.push('/new'),
  '?': () => help.value?.showModal(),
});
const inApps = () => route.path.startsWith('/applications');
</script>

<template>
  <header class="topbar">
    <div class="topbar-inner">
      <RouterLink to="/" class="brand">Agentic OS</RouterLink>
      <nav class="nav" aria-label="Main">
        <RouterLink to="/" exact-active-class="router-link-active" active-class="">Home</RouterLink>
        <RouterLink to="/applications" :class="{ active: inApps() }">Applications</RouterLink>
        <RouterLink to="/cv">Master CV</RouterLink>
        <RouterLink to="/review">
          Review
          <span v-if="review.total" class="badge count">{{ review.total }}<span class="sr-only"> waiting</span></span>
        </RouterLink>
      </nav>
      <button type="button" class="quiet" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" @click="help?.showModal()"><kbd>?</kbd></button>
    </div>
  </header>
  <dialog ref="help" class="keys" aria-labelledby="keys-title" @click.self="help?.close()">
    <h2 id="keys-title">Keyboard shortcuts</h2>
    <dl>
      <dt><kbd>n</kbd></dt><dd>New application</dd>
      <dt><kbd>/</kbd></dt><dd>Search applications</dd>
      <dt><kbd>g</kbd> <kbd>h</kbd></dt><dd>Home</dd>
      <dt><kbd>g</kbd> <kbd>a</kbd></dt><dd>Applications</dd>
      <dt><kbd>g</kbd> <kbd>c</kbd></dt><dd>Master CV</dd>
      <dt><kbd>g</kbd> <kbd>r</kbd></dt><dd>Review</dd>
      <dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>Next or previous line of a draft</dd>
      <dt><kbd>e</kbd></dt><dd>Edit the line in focus</dd>
      <dt><kbd>Ctrl</kbd> <kbd>Enter</kbd></dt><dd>Save while editing; <kbd>Esc</kbd> cancels</dd>
    </dl>
    <form method="dialog"><button type="submit">Close</button></form>
  </dialog>
</template>
