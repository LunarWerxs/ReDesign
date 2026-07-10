import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/', name: 'Control', component: () => import('@/pages/Control.vue') },
  { path: '/viewer', name: 'Viewer', component: () => import('@/pages/Viewer.vue') },
  { path: '/:pathMatch(.*)*', name: 'NotFound', component: () => import('@/pages/NotFound.vue') },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

export default router;
