/**
 * The run store: everything that reads or writes output/<runId>/manifest.json.
 *
 * This file is the public surface and nothing else — the implementation lives in the
 * slices under src/store/, split the way src/web/src/stores/control.ts is split over
 * src/web/src/stores/control/. Consumers keep importing `* as store from "../store"`;
 * the named exports below are exactly the ones this module has always had.
 *
 *   paths.ts      where a run lives, what it is called, traversal rejection
 *   types.ts      manifest/summary shapes + the status vocabulary
 *   summary.ts    the runs-picker summary and its mtime-keyed cache
 *   stale.ts      settling runs orphaned by a dead daemon
 *   manifests.ts  manifest read/write + the run listing
 *   retention.ts  disk usage, the retention sweep, run deletion
 */
export { OUTPUT_DIR, newRunId, runDir, manifestPath } from "./store/paths";
export { writeManifest, readManifest, listRuns, settleStaleRuns } from "./store/manifests";
export { settleStaleManifest } from "./store/stale";
export { pruneRuns, outputBytes, deleteRun } from "./store/retention";
export type { Manifest, Job, Counts, RunSummary, ReadManifestOptions, PruneRunsResult } from "./store/types";
