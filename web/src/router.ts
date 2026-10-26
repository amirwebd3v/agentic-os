import { createRouter, createWebHashHistory } from 'vue-router';
import ChatView from './views/ChatView.vue';

// Hash history: the server serves web/dist statically with no SPA fallback, so /s/5 must not hit it on reload.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: ChatView },
    { path: '/s/:id(\\d+)', component: ChatView, props: (r) => ({ id: Number(r.params.id) }) },
    { path: '/review', component: () => import('./views/ReviewView.vue') },
  ],
});
