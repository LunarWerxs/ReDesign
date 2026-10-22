/**
 * Reading and writing manifest.json and its lightweight paginated history. Ordinary reads
 * are non-mutating; explicit maintenance reconciliation settles unowned interrupted runs.
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

function readRunSummary(name: string, mp: string, opts: NormalizedStaleOptions, cacheIfRoom = false): RunSummary | null {
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
    cacheRunSummary(mp, { mtimeMs: nextStat.mtimeMs, size: nextStat.size, summary }, { ifRoom: cacheIfRoom });
  } catch (_) {
    cacheRunSummary(mp, { mtimeMs: st.mtimeMs, size: st.size, summary }, { ifRoom: cacheIfRoom });
  }
  return summary;
}

// List runs newest-first with a light summary for the runs picker.
function listRuns(options: ReadManifestOptions = {}): RunSummary[] {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  const opts = normalizeStaleOptions(options);
  const out: RunSummary[] = [];
  for (const name of fs.readdirSync(OUTPUT_DIR).sort((a, b) => b.localeCompare(a))) {
    const mp = path.join(OUTPUT_DIR, name, "manifest.json");
    const summary = readRunSummary(name, mp, opts, true);
    if (summary) out.push(summary);
  }
  return out.sort((a, b) => String(b.runId).localeCompare(String(a.runId)));
}

export interface RunPage { runs: RunSummary[]; nextCursor: string | null; }
/**
 * History reader for the UI: inspect only one bounded page of manifests. Cursor is the last
 * returned directory name (run ids are sortable timestamps), never an offset that can drift
 * when a new run arrives. The legacy listRuns remains for maintenance callers that truly need
 * all history.
 */
function listRunsPage({ cursor, limit = 50, options = {} }: { cursor?: string | null; limit?: number; options?: ReadManifestOptions } = {}): RunPage {
  if (!fs.existsSync(OUTPUT_DIR)) return { runs: [], nextCursor: null };
  const max = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  const names = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
  const start = cursor ? names.findIndex((name) => name.localeCompare(cursor) < 0) : 0;
  if (start < 0) return { runs: [], nextCursor: null };
  const opts = normalizeStaleOptions(options);
  const runs: RunSummary[] = [];
  let last: string | null = null;
  for (let index = start; index < names.length && runs.length < max; index++) {
    const name = names[index] as string;
    last = name;
    const summary = readRunSummary(name, path.join(OUTPUT_DIR, name, "manifest.json"), opts);
    if (summary) runs.push(summary);
  }
  const hasMore = !!last && names.some((name) => name.localeCompare(last) < 0);
  return { runs, nextCursor: hasMore ? last : null };
}

interface SettleStaleRunsResult {
  settled: string[];
  runs: RunSummary[];
}

function settleStaleRuns(options: ReadManifestOptions = {}): SettleStaleRunsResult {
  if (!fs.existsSync(OUTPUT_DIR)) return { settled: [], runs: [] };
  const opts = normalizeStaleOptions({ ...options, reconcile: true });
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
  return { settled, runs: listRuns({ ...opts, reconcile: true }) };
}

export { writeManifest, readManifest, listRuns, listRunsPage, settleStaleRuns };
export type { SettleStaleRunsResult };
