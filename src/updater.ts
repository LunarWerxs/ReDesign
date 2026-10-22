/**
 * RēDesign self-update, thin adapter over the SHARED kit updater engine (synced in as
 * ./updater-engine.mjs). All the git / spawn / ls-remote / apply logic lives once in that
 * engine (edit it in the shared kit, never here); only RēDesign's checkout root,
 * REIMAGINE_UPDATE_REPO env var, npm install / build commands, and the "redesign" service
 * identity are local. `serviceName` is a purely local identifier (only this app's own web UI
 * reads UpdateStatus.service, see src/web/src/types/index.ts), renamed to match the other
 * post-migration identifiers (Connections pulse `app`, MCP `serverInfo.name`), which already
 * moved to "redesign". `updateRepoEnvVar`'s name is left as REIMAGINE_UPDATE_REPO: it's a
 * machine env var an owner may already have set on a deployed box, so it's not renamed here.
 * The engine is ESM and this file is now ESM/TS too, so, exactly like src/mcp/stdio.ts's
 * static import of ./mcp-stdio.mjs, createUpdater is imported statically instead of via the
 * old updater.js's dynamic `import('./updater-engine.mjs')` bridge. The lazy singleton is
 * preserved (the engine's git/spawn plumbing is still built once, on first use, not at module
 * load) and the exported checkForUpdate/applyUpdate keep their previous names + async
 * signatures for the /api/updates routes.
 */

import { dirname } from "node:path";
import {
  applyUpdate as applyReleaseUpdate,
  checkForUpdate as checkReleaseUpdate,
  cleanupStaleUpdateArtifacts as cleanupReleaseArtifacts,
} from "./github-updater";
import { acquireUpdateLock } from "./update-lock";
import { createUpdater, type Updater } from "./updater-engine.mjs";
import { IS_PACKAGED, ROOT } from "./util";

// Lazy singleton: first call builds the engine; later calls reuse it.
let engineInstance: Updater | null = null;
function engine(): Updater {
  if (!engineInstance) {
    engineInstance = createUpdater({
      appRoot: ROOT,
      serviceName: "redesign",
      appLabel: "RēDesign",
      updateRepoEnvVar: "REIMAGINE_UPDATE_REPO",
      // The source checkout commits bun.lock. npm install invents package-lock.json and then
      // makes the next update refuse the now-dirty tree.
      installCmd: ["bun", "install", "--frozen-lockfile"],
      // The web app has its own committed npm lock. A source self-update must not resolve it
      // through the developer's ambient node_modules before declaring the checkout healthy.
      buildCmd: ["bun", "run", "build:web:locked"],
    });
  }
  return engineInstance;
}

async function checkForUpdate() {
  return IS_PACKAGED ? checkReleaseUpdate() : engine().checkForUpdate();
}

let applying: Promise<Awaited<ReturnType<typeof applyReleaseUpdate>>> | null = null;

async function applyUpdate() {
  // The auto-update timer and a manual /api/updates request share this promise, so both callers
  // observe one transaction rather than racing through staging/swap independently.
  if (applying) return applying;
  const installDir = IS_PACKAGED ? dirname(process.execPath) : ROOT;
  const lock = acquireUpdateLock(installDir);
  if (!lock) {
    return {
      ok: false,
      message: "An update is already being applied by another RēDesign process.",
      restartRequired: false,
      status: await checkForUpdate(),
      output: [],
    };
  }
  applying = (IS_PACKAGED ? applyReleaseUpdate() : engine().applyUpdate()).finally(() => {
    lock.release();
    applying = null;
  });
  return applying;
}

function cleanupStaleUpdateArtifacts(): void {
  if (IS_PACKAGED) cleanupReleaseArtifacts();
}

export { applyUpdate, checkForUpdate, cleanupStaleUpdateArtifacts };
