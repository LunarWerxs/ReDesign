import { defineConfig, type Plugin } from 'vite';
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
/**
 * Drop the kit's Google Fonts `@import` from this app's CSS, because we serve Inter ourselves.
 *
 * styles/kit-base.css opens with `@import url('https://fonts.googleapis.com/css2?family=Inter...')`.
 * A remote @import at the head of a render-blocking stylesheet blocks first paint on a round trip
 * to fonts.googleapis.com: pure dead time for a local desktop app, and an outright stall with no
 * network. The app's entry stylesheet declares the same typeface from public/fonts/ instead; this
 * removes the remote one so the two don't both load.
 *
 * Done here rather than by editing kit-base.css because that file is VENDORED FROM THE SHARED KIT
 * (lunarwerx-ui) and its `--check` fails on any byte of drift. Stripping at build time keeps the
 * checked-in copy identical to the kit while this app opts out of the behaviour.
 */
function stripRemoteFontImport(): Plugin {
  // Both spellings: `@import url('https://...');` as authored in the kit, and the bare
  // `@import"https://...";` Tailwind re-serialises it to.
  //
  // The URL body is matched up to its QUOTE or CLOSING PAREN, never up to a semicolon: the Google
  // Fonts URL contains semicolons of its own (`wght@400;500;600;700`). Matching to `;` cuts the
  // at-rule in half and leaves garbage at the head of the stylesheet, which makes the browser fail
  // to parse the whole file and drops the entire UI to unstyled Times New Roman. Keep these
  // terminators as they are.
  const REMOTE_FONT_IMPORT = new RegExp(
    [
      // @import url("https://fonts.googleapis.com/…") ;   (quoted inside url())
      String.raw`@import\s*url\(\s*(['"])https:\/\/fonts\.googleapis\.com[^'"]*\1\s*\)\s*;`,
      // @import url(https://fonts.googleapis.com/…) ;     (bare inside url())
      String.raw`@import\s*url\(\s*https:\/\/fonts\.googleapis\.com[^)]*\)\s*;`,
      // @import "https://fonts.googleapis.com/…" ;        (no url(), what Tailwind emits)
      String.raw`@import\s*(['"])https:\/\/fonts\.googleapis\.com[^'"]*\2\s*;`,
    ].join("|"),
    "g",
  );
  const strip = (css: string) => css.replace(REMOTE_FONT_IMPORT, "");
  return {
    name: "strip-remote-font-import",
    enforce: "post",
    transform(code, id) {
      if (!id.endsWith(".css") || !code.includes("fonts.googleapis.com")) return null;
      return { code: strip(code), map: null };
    },
    // The hook that actually does the work: @tailwindcss/vite assembles the final stylesheet
    // outside the transform pipeline above, so the `post` transform never sees it. Whatever
    // produced the CSS, the file the daemon serves must not carry a remote font import.
    //
    // Caveat, deliberate: this runs AFTER Rollup hashes the asset filename, so the hash describes
    // the pre-strip content. Harmless in practice (the strip is deterministic), but editing THIS
    // PLUGIN without touching any CSS reuses the old filename. Hard-reload when iterating here.
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !file.fileName.endsWith(".css")) continue;
        const css =
          typeof file.source === "string" ? file.source : Buffer.from(file.source).toString("utf8");
        if (!css.includes("fonts.googleapis.com")) continue;
        const next = strip(css);
        if (next.includes("fonts.googleapis.com"))
          this.warn(`${file.fileName} still references fonts.googleapis.com; check the pattern.`);
        file.source = next;
      }
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [stripRemoteFontImport(), vue(), tailwindcss()],
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
