/**
 * Running-instance pointer, a thin per-app adapter over the shared kit factory
 * (`createInstancePointer`, synced in as `./instance-pointer.mjs`). The only local code is
 * ReDesign's config-dir resolution (honours REDESIGN_HOME, defaulting to ~/.redesign) plus its
 * service/host identity. The daemon records the port it ACTUALLY bound in
 * `<configDir>/runtime.json` so the CLI, tray, and start.cmd can find it and enforce
 * single-instance via GET /api/health. Best-effort throughout (mirrors RepoYeti's src/instance.ts).
 */
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
export const readInstanceInfo = pointer.readInstanceInfo;
export const clearInstanceInfo = pointer.clearInstanceInfo;
export const findLiveInstance = pointer.findLiveInstance;
