/**
 * Running-instance pointer, a thin per-app adapter over the shared kit factory
 * (`createInstancePointer`, synced in as `./instance-pointer.mjs`). The only local code is
 * ReDesign's config-dir resolution (honours REDESIGN_HOME, defaulting to ~/.redesign) plus its
 * service/host identity. The daemon records the port it ACTUALLY bound in
 * `<configDir>/runtime.json` so the CLI, tray, and start.cmd can find it and enforce
 * single-instance via GET /api/health. Best-effort throughout (mirrors RepoYeti's src/instance.ts).
 */
import { rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInstancePointer, type InstanceInfo } from "./instance-pointer.mjs";

export type { InstanceInfo };

const CONFIG_DIR = process.env.REDESIGN_HOME?.trim() || join(homedir(), ".redesign");

const pointer = createInstancePointer({
  configDir: CONFIG_DIR,
  serviceName: "redesign",
  host: "127.0.0.1",
});

export const instanceFilePath = pointer.instanceFilePath;
export const writeInstanceInfo = pointer.writeInstanceInfo;
export const updateInstanceInfo = pointer.updateInstanceInfo;
export const readInstanceInfo = pointer.readInstanceInfo;
export const clearInstanceInfo = pointer.clearInstanceInfo;
export const findLiveInstance = pointer.findLiveInstance;

// ---------------------------------------------------------------------------
// "Full shutdown requested" sentinel — a marker file the PowerShell tray host polls so a
// user "Shut Down" from the web UI (or `redesign stop`) tears down the WHOLE app,
// notification-area icon included, not just the daemon. It lives beside runtime.json in
// CONFIG_DIR. The tray never calls POST /api/shutdown (it stops the daemon by port), so any
// request that reaches that route IS a user shutdown and drops this; the daemon clears it on
// boot and the tray clears it at startup, so a stale one never causes a spurious quit.
// Best-effort throughout (a tray that misses it still has its own Quit).
// ---------------------------------------------------------------------------
const SHUTDOWN_REQUEST_FILE = join(CONFIG_DIR, "shutdown.request");
export function writeShutdownRequest(): void {
  try {
    writeFileSync(SHUTDOWN_REQUEST_FILE, JSON.stringify({ ts: Date.now() }), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}
export function clearShutdownRequest(): void {
  try {
    rmSync(SHUTDOWN_REQUEST_FILE, { force: true });
  } catch {
    /* best-effort */
  }
}
