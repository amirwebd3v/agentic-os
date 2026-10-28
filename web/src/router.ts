import { createRouter, createWebHashHistory } from 'vue-router';

// Hash history: the server serves web/dist statically with no SPA fallback, so a deep link must not hit it on reload.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/applications', component: () => import('./views/ApplicationsView.vue') },
    { path: '/applications/:id(\\d+)', component: () => import('./views/ApplicationView.vue'), props: true },
    { path: '/review', component: () => import('./views/ReviewView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/applications' },
  ],
});
