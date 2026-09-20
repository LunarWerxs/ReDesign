// Fail when src/web's package-lock.json no longer records the ranges package.json declares.
//
// WHY THIS EXISTS. `src/web` carries BOTH a bun.lock and an npm package-lock.json, and CI's web
// job installs with `npm ci` - which refuses outright when the two disagree:
//
//     npm error `npm ci` can only install packages when your package.json and
//     npm error package-lock.json ... are in sync.
//     npm error Invalid: lock file's @cnct/connect@1.5.1 does not satisfy @cnct/connect@1.5.2
//
// A dependency bump done with bun refreshes the bun lock and leaves the npm one behind, so every
// LOCAL gate passes and the tagged build dies in CI. That has now happened twice: once before
// 2026-09-16 (`fix(ci): the web job's out-of-sync lockfile`) and again on 2026-09-20, where it
// killed a release build. Twice is a pattern, and a pattern deserves an instrument.
//
// HOW IT CHECKS. npm records the DECLARED range for each root dependency in the lockfile's own
// `packages[""]` entry. `npm ci` compares exactly those strings against package.json, so this
// check does the same: no semver evaluation, no registry, no install - the same comparison npm
// makes, in milliseconds, before the push rather than after it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "web");
const manifestPath = join(webDir, "package.json");
const lockPath = join(webDir, "package-lock.json");

if (!existsSync(lockPath)) {
  // No npm lockfile is a valid state - it only becomes a trap once `npm ci` depends on one.
  console.log("web-lockfile-in-sync: src/web has no package-lock.json, nothing to compare");
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const lockRoot = JSON.parse(readFileSync(lockPath, "utf8")).packages?.[""] ?? {};

const problems = [];
for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  const declared = manifest[field] ?? {};
  const locked = lockRoot[field] ?? {};
  for (const [name, range] of Object.entries(declared)) {
    if (!(name in locked)) problems.push(`${field}.${name}: declared ${range}, absent from the lockfile`);
    else if (locked[name] !== range)
      problems.push(`${field}.${name}: package.json says ${range}, the lockfile records ${locked[name]}`);
  }
  for (const name of Object.keys(locked)) {
    if (!(name in declared)) problems.push(`${field}.${name}: in the lockfile, no longer declared`);
  }
}

if (problems.length > 0) {
  console.error("web-lockfile-in-sync: src/web's package-lock.json is out of step with its package.json");
  console.error("  `npm ci` in the web CI job will REFUSE this tree, and a tagged build will die there.\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error("\n  Fix: npm install --package-lock-only   (run it in src/web, then commit the lockfile)");
  process.exit(1);
}

console.log(`web-lockfile-in-sync: src/web's two manifests agree (${Object.keys(lockRoot.dependencies ?? {}).length} deps, ${Object.keys(lockRoot.devDependencies ?? {}).length} dev)`);
