import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// The Node backend runs here in dev; the Vite dev server proxies API + asset
// routes to it. The browser sends Origin: http://localhost:5173, which the
// backend's originAllowed() allow-list accepts (it lists the dev origin), so
// CSRF protection stays intact, we do NOT spoof the Origin header.
const BACKEND = 'http://127.0.0.1:5178';

const apiProxy = {
  target: BACKEND,
  changeOrigin: true,
};

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': apiProxy,
      '/input': apiProxy,
      '/reference': apiProxy,
      '/output': apiProxy,
      '/output-raw': apiProxy,
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    // @vueuse/core ships /* #__PURE__ */ comments in positions rolldown can't bind to a call
    // expression (e.g. before an object literal), so it flags them as INVALID_ANNOTATION even
    // though the annotation is inert there. Silence that one benign check to keep builds quiet.
    rollupOptions: { checks: { invalidAnnotation: false } },
  },
});
