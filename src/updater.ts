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
import { ROOT } from "./util";
import { createUpdater, type Updater } from "./updater-engine.mjs";

// Lazy singleton: first call builds the engine; later calls reuse it.
let engineInstance: Updater | null = null;
function engine(): Updater {
  if (!engineInstance) {
    engineInstance = createUpdater({
      appRoot: ROOT,
      serviceName: "redesign",
      appLabel: "RēDesign",
      updateRepoEnvVar: "REIMAGINE_UPDATE_REPO",
      installCmd: ["npm", "install"],
      buildCmd: ["npm", "run", "build"],
    });
  }
  return engineInstance;
}

async function checkForUpdate() {
  return engine().checkForUpdate();
}

async function applyUpdate() {
  return engine().applyUpdate();
}

export { checkForUpdate, applyUpdate };
