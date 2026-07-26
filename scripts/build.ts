#!/usr/bin/env bun
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { $ } from "bun";
import pkg from "../package.json";

/**
 * Build a distributable RēDesign executable into `dist/`:
 *   dist/redesign[.exe] — compiled daemon, Vue UI, and seed configuration
 *
 * The generated compile-only entrypoint embeds every Vite file. Editable models/prompts are seeded
 * from JSON imports into ~/.redesign/config on first packaged launch, so the public artifact is one
 * file and does not unpack a source-shaped directory tree beside itself.
 * Run: `bun run dist` (== `bun run scripts/build.ts`)
 */
const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const TMP = join(ROOT, "tmp", "release-build");
const isWin = process.platform === "win32";
const outBin = join(DIST, isWin ? "redesign.exe" : "redesign");

function setWindowsGuiSubsystem(path: string): void {
  const image = readFileSync(path);
  if (image.length < 256 || image[0] !== 0x4d || image[1] !== 0x5a) {
    throw new Error("compiled Windows executable has no valid MZ header");
  }
  const pe = image.readInt32LE(0x3c);
  if (pe < 0 || pe + 94 >= image.length || image.readUInt32LE(pe) !== 0x0000_4550) {
    throw new Error("compiled Windows executable has no valid PE header");
  }
  // Bun 1.3.14's --windows-hide-console suppresses its own console handling but still emits
  // IMAGE_SUBSYSTEM_WINDOWS_CUI (3). Windows can consequently create a visible console before
  // Bun gets a chance to hide it. Stamp the loader-level GUI subsystem and clear the optional
  // PE checksum (Windows does not require one for ordinary user-mode executables).
  image.writeUInt16LE(2, pe + 92);
  image.writeUInt32LE(0, pe + 88);
  writeFileSync(path, image);
  if (readFileSync(path).readUInt16LE(pe + 92) !== 2) {
    throw new Error("failed to stamp Windows GUI subsystem");
  }
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

function importPath(fromFile: string, target: string): string {
  const rel = relative(dirname(fromFile), target).replaceAll("\\", "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function writeReleaseEntrypoint(): string {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const entry = join(TMP, "entry.ts");
  const webRoot = join(ROOT, "src", "web", "dist");
  const files = filesUnder(webRoot);
  const imports = files.map(
    (file, index) =>
      `import asset${index} from ${JSON.stringify(importPath(entry, file))} with { type: "file" };`,
  );
  const routes = files.map((file, index) => [
    `/${relative(webRoot, file).replaceAll("\\", "/")}`,
    `asset${index}`,
  ]);
  writeFileSync(
    entry,
    `${imports.join("\n")}

(globalThis as { __REDESIGN_EMBEDDED_WEB__?: Readonly<Record<string, string>> })
  .__REDESIGN_EMBEDDED_WEB__ = Object.freeze({
${routes.map(([route, asset]) => `  ${JSON.stringify(route)}: ${asset},`).join("\n")}
});
(globalThis as { __REDESIGN_RELEASE_BUILD__?: boolean }).__REDESIGN_RELEASE_BUILD__ = true;
await import(${JSON.stringify(importPath(entry, join(ROOT, "src", "index.ts")))});
`,
  );
  return entry;
}

console.log("→ clean dist/");
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

console.log("→ install web deps (npm ci); a fresh checkout or CI has no src/web/node_modules");
await $`npm --prefix ${join(ROOT, "src", "web")} ci`;
console.log("→ build web (vite)");
await $`npm --prefix ${join(ROOT, "src", "web")} run build`;

console.log("→ compile daemon + embedded web app (bun --compile)");
const releaseEntry = writeReleaseEntrypoint();
try {
  if (isWin) {
    await $`bun build --compile --minify --windows-hide-console --windows-icon=${join(ROOT, "misc", "ReDesign.ico")} --windows-title=${"RēDesign"} --windows-publisher=LunarWerx --windows-version=${`${pkg.version}.0`} --windows-description=${"AI UI redesign workbench"} ${releaseEntry} --outfile ${outBin}`;
  } else {
    await $`bun build --compile --minify ${releaseEntry} --outfile ${outBin}`;
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
if (isWin) setWindowsGuiSubsystem(outBin);

console.log(`\n✓ Built ${outBin}`);
console.log(`  Run it:  ${isWin ? "dist\\redesign.exe" : "./dist/redesign"}`);
console.log("  (API keys and editable configuration live in the per-user RēDesign home)");
