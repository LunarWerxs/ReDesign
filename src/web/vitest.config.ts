import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

// Dedicated test config, kept separate from vite.config.ts so the tailwind plugin and the dev
// proxy (neither of which the unit + component tests need) stay out of the test pipeline. The
// `@` alias mirrors vite.config.ts.
//
// These run under VITEST via `npm run test`, never under `bun test`. Bun's runner has no Vue SFC
// compiler, so a `.vue` import resolves to a string path and @vue/test-utils throws a WeakMap
// key error. The daemon suite at the repo root is the bun:test one; this half is Vitest's.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.{test,spec}.ts"],
    exclude: ["node_modules/**", "test/setup.ts"],
  },
});
