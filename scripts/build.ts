#!/usr/bin/env bun
/**
 * Build a distributable RēDesign bundle into `dist/`:
 *   dist/redesign[.exe], the compiled daemon (bun --compile, single self-contained binary)
 *   dist/src/web/dist/..., the built GUI (served at ROOT/src/web/dist, see src/http/web.ts WEB_DIST)
 *   dist/src/config/..., the model/prompt config the app reads + writes (ROOT/src/config)
 *
 * Host-native compile (no `--target`), each OS's CI runner compiles its own binary, mirroring
 * RepoYeti's scripts/build.ts. At runtime the app reads files relative to ROOT; in a compiled binary
 * ROOT resolves to the executable's dir (see src/util.ts), so the two ship-with-the-app trees (web
 * dist + config) are copied NEXT TO the binary here, preserving their `src/...` sub-paths. `.env` is
 * deliberately NOT bundled (it holds the user's secret API keys, the user supplies their own, or sets
 * keys via the UI at runtime). output/, input/, reference/ are created next to the binary on demand.
 *
 * No `--external` needed, RēDesign has zero native-FFI runtime deps.
 * Run: `bun run dist` (== `bun run scripts/build.ts`)
 */
import { $ } from "bun";
import { rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const isWin = process.platform === "win32";
const outBin = join(DIST, isWin ? "redesign.exe" : "redesign");

console.log("→ clean dist/");
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log("→ install web deps (npm ci); a fresh checkout or CI has no src/web/node_modules");
await $`npm --prefix ${join(ROOT, "src", "web")} ci`;
console.log("→ build web (vite)");
await $`npm --prefix ${join(ROOT, "src", "web")} run build`;

console.log("→ compile daemon (bun --compile)");
await $`bun build --compile --minify ${join(ROOT, "src", "index.ts")} --outfile ${outBin}`;

console.log("→ copy the runtime files the app reads relative to ROOT, next to the binary");
// web GUI (served at ROOT/src/web/dist)
mkdirSync(join(DIST, "src", "web"), { recursive: true });
cpSync(join(ROOT, "src", "web", "dist"), join(DIST, "src", "web", "dist"), { recursive: true });
// model/prompt config (read + written at ROOT/src/config). JSON files only, the .ts there is bundled.
mkdirSync(join(DIST, "src", "config"), { recursive: true });
for (const f of ["models.json", "prompts.json", "prompts.defaults.json", "pricing.json"]) {
  const src = join(ROOT, "src", "config", f);
  if (existsSync(src)) cpSync(src, join(DIST, "src", "config", f));
}

console.log(`\n✓ Built ${outBin}`);
console.log(`  Run it:  ${isWin ? "dist\\redesign.exe" : "./dist/redesign"}`);
console.log("  (drop a .env with your API keys next to the binary, or set keys in the UI)");
