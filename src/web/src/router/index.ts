import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/', name: 'Control', component: () => import('@/pages/Control.vue') },
  { path: '/viewer', name: 'Viewer', component: () => import('@/pages/Viewer.vue') },
  { path: '/:pathMatch(.*)*', name: 'NotFound', component: () => import('@/pages/NotFound.vue') },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  /**
   * Every navigation lands at the top of the page.
   *
   * Vue Router does nothing here by default, so an SPA route change simply KEEPS the previous
   * page's scroll offset: switching to the viewer from a scrolled dashboard dropped you into
   * the middle of the gallery for no visible reason. `savedPosition` is deliberately ignored
   * rather than restored — the viewer's cards are lazily-loaded iframes whose heights only
   * settle after paint, so a "restored" offset lands somewhere unrelated by the time the page
   * has finished laying out. (The matching browser-level restore on a hard reload is turned off
   * in main.ts, for the same reason.)
   */
  scrollBehavior: () => ({ top: 0 }),
});

export default router;
