/**
 * Reading and writing manifest.json, and the run listing built on top of it. Every path in
 * here runs a manifest through the stale check on the way out, so no caller can observe a
 * run that has been dead for a day still claiming to be running.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJSON, writeJSON } from "../util";
import { ACTIVE_RUN_STATUSES } from "./types";
import type { Manifest, ReadManifestOptions, RunSummary } from "./types";
import { OUTPUT_DIR, manifestPath, runDir } from "./paths";
import { cacheRunSummary, runSummaryCache, summarizeManifest } from "./summary";
import { maybeSettleStaleManifest, normalizeStaleOptions, shouldSettleStaleManifest } from "./stale";
import type { NormalizedStaleOptions } from "./stale";

function writeManifest(runId: string, manifest: Manifest): void {
  ensureDir(runDir(runId));
  const mp = manifestPath(runId);
  // Compact, not pretty-printed: this is rewritten every 750ms for the whole length of a run and
  // grows with the job count, so the indentation is the majority of the bytes written. Everything
  // that reads it back goes through JSON.parse, and the viewer renders it, so nothing depends on
  // the on-disk formatting.
  writeJSON(mp, manifest, { pretty: false });
  try {
    const st = fs.statSync(mp);
    cacheRunSummary(mp, { mtimeMs: st.mtimeMs, size: st.size, summary: summarizeManifest(manifest, runId) });
  } catch (_) {
    runSummaryCache.delete(mp);
  }
}

function readManifest(runId: string, options: ReadManifestOptions = {}): Manifest | null {
  const mp = manifestPath(runId);
  let st: fs.Stats;
  try {
    st = fs.statSync(mp);
  } catch (_) {
    return null;
  }
  const manifest = readJSON<Manifest | null>(mp, null);
  if (!manifest) return null;
  return maybeSettleStaleManifest(runId, mp, manifest, st, normalizeStaleOptions(options)).manifest;
}

function readRunSummary(name: string, mp: string, opts: NormalizedStaleOptions): RunSummary | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(mp);
  } catch (_) {
    runSummaryCache.delete(mp);
    return null;
  }
  const cached = runSummaryCache.get(mp);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    if (!ACTIVE_RUN_STATUSES.has(cached.summary.status) || !shouldSettleStaleManifest(cached.summary.runId, cached.summary as unknown as Manifest, st, opts)) {
      return cached.summary;
    }
  }
  const m = readJSON<Manifest | null>(mp, null);
  if (!m) {
    runSummaryCache.delete(mp);
    return null;
  }
  const settled = maybeSettleStaleManifest(name, mp, m, st, opts).manifest;
  const summary = summarizeManifest(settled, name);
  try {
    const nextStat = fs.statSync(mp);
    cacheRunSummary(mp, { mtimeMs: nextStat.mtimeMs, size: nextStat.size, summary });
  } catch (_) {
    cacheRunSummary(mp, { mtimeMs: st.mtimeMs, size: st.size, summary });
  }
  return summary;
}

// List runs newest-first with a light summary for the runs picker.
function listRuns(options: ReadManifestOptions = {}): RunSummary[] {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  const opts = normalizeStaleOptions(options);
  const out: RunSummary[] = [];
  for (const name of fs.readdirSync(OUTPUT_DIR)) {
    const mp = path.join(OUTPUT_DIR, name, "manifest.json");
    const summary = readRunSummary(name, mp, opts);
    if (summary) out.push(summary);
  }
  return out.sort((a, b) => String(b.runId).localeCompare(String(a.runId)));
}

interface SettleStaleRunsResult {
  settled: string[];
  runs: RunSummary[];
}

function settleStaleRuns(options: ReadManifestOptions = {}): SettleStaleRunsResult {
  if (!fs.existsSync(OUTPUT_DIR)) return { settled: [], runs: [] };
  const opts = normalizeStaleOptions(options);
  const settled: string[] = [];
  for (const name of fs.readdirSync(OUTPUT_DIR)) {
    const mp = path.join(OUTPUT_DIR, name, "manifest.json");
    let st: fs.Stats;
    try {
      st = fs.statSync(mp);
    } catch (_) {
      continue;
    }
    const manifest = readJSON<Manifest | null>(mp, null);
    if (!manifest) continue;
    const result = maybeSettleStaleManifest(name, mp, manifest, st, opts);
    if (result.stale) settled.push(result.manifest.runId || name);
  }
  return { settled, runs: listRuns(opts) };
}

export { writeManifest, readManifest, listRuns, settleStaleRuns };
export type { SettleStaleRunsResult };
