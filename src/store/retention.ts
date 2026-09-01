/**
 * Disk accounting and deletion: the output/ size readout in Settings, the opt-in retention
 * sweep, and the explicit per-run delete. Everything here destroys the user's saved work, so
 * every uncertain case (active run, unparseable manifest, unknown age) resolves to "keep".
 */
import fs from "node:fs";
import path from "node:path";
import { readJSON } from "../util";
import { ACTIVE_RUN_STATUSES, statusError } from "./types";
import type { Manifest, PruneRunsResult } from "./types";
import { OUTPUT_DIR, resolveRunDir } from "./paths";
import { runSummaryCache } from "./summary";
import { manifestActivityMs } from "./stale";

/** Total bytes under a run dir. Best-effort: an unreadable entry contributes 0 rather than throwing. */
function runDirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += runDirBytes(full);
    else {
      try {
        total += fs.statSync(full).size;
      } catch (_) {
        /* vanished mid-walk */
      }
    }
  }
  return total;
}

/** Bytes currently held by output/, for the disk-usage readout in Settings. */
function outputBytes(): number {
  return fs.existsSync(OUTPUT_DIR) ? runDirBytes(OUTPUT_DIR) : 0;
}

/**
 * Delete FINISHED runs whose last activity is older than `maxAgeDays`. Opt-in retention, swept
 * once at boot (see app-settings.ts outputRetentionDays and the call in http/serve.ts): before
 * this, nothing ever removed a run except the user, so output/ grew forever.
 *
 * Deliberately conservative. A run that is still active, or that has no parseable manifest, or
 * whose age cannot be established, is LEFT ALONE. This function destroys the user's saved work,
 * so every uncertain case has to resolve to "keep".
 */
function pruneRuns({ maxAgeDays, nowMs = Date.now() }: { maxAgeDays: number; nowMs?: number }): PruneRunsResult {
  const result: PruneRunsResult = { deleted: [], freedBytes: 0 };
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return result;
  if (!fs.existsSync(OUTPUT_DIR)) return result;
  const cutoff = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;

  for (const name of fs.readdirSync(OUTPUT_DIR)) {
    const dir = path.join(OUTPUT_DIR, name);
    const mp = path.join(dir, "manifest.json");
    let st: fs.Stats;
    try {
      st = fs.statSync(mp);
    } catch (_) {
      continue; // not a run dir (the small state files beside them live here too)
    }
    const manifest = readJSON<Manifest | null>(mp, null);
    if (!manifest) continue;
    if (ACTIVE_RUN_STATUSES.has(manifest.status)) continue;
    const lastActivity = manifestActivityMs(manifest, st);
    if (!lastActivity || lastActivity >= cutoff) continue;
    const bytes = runDirBytes(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: false });
    } catch (_) {
      continue;
    }
    runSummaryCache.delete(mp);
    result.deleted.push(manifest.runId || name);
    result.freedBytes += bytes;
  }
  return result;
}

function deleteRun(runId: unknown): string {
  const dir = resolveRunDir(runId);
  const mp = path.join(dir, "manifest.json");
  let st: fs.Stats;
  try {
    st = fs.statSync(mp);
  } catch (_) {
    throw statusError("run not found", 404);
  }
  if (!st.isFile()) throw statusError("run not found", 404);
  fs.rmSync(dir, { recursive: true, force: false });
  runSummaryCache.delete(mp);
  return String(runId);
}

export { outputBytes, pruneRuns, deleteRun };
