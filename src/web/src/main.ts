import { createApp } from 'vue';
import { createPinia } from 'pinia';
import 'vue-sonner/style.css';
import './assets/index.css';
import App from './App.vue';
import router from './router';
import { i18n } from './i18n';

// Recover from stale-chunk errors. When the daemon ships a new build, its hashed chunk names
// change; a tab still running the old build then lazy-imports a chunk that no longer exists on
// disk and the import rejects (Vite fires `vite:preloadError`; the server already returns a real
// 404 for missing /assets/ files, see src/server/fileServing.js serveFile). Reload once to pull
// the fresh build instead of showing a dead view. A short timestamp guard prevents a reload loop
// if the new build is genuinely broken (chunk truly missing). Mirrors RepoYeti/DevWebUI.
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'reimagine:last-chunk-reload';
  const now = Date.now();
  if (now - Number(sessionStorage.getItem(KEY) ?? 0) < 10_000) {
    console.error('[reimagine] chunk failed to load again right after a reload', event);
    return;
  }
  sessionStorage.setItem(KEY, String(now));
  event.preventDefault();
  window.location.reload();
});

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(i18n);
app.mount('#app');
