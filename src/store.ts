import fs from "node:fs";
import path from "node:path";
import { ROOT, ensureDir, readJSON, writeJSON, slugify, resolveInside } from "./util";

const OUTPUT_DIR = path.join(ROOT, "output");

interface RunSummary {
  runId: string;
  createdAt?: string;
  finishedAt: string | null;
  status: string;
  summary: unknown;
  title: string | null;
  counts: unknown;
  cost?: Manifest["cost"];
  models: string[];
  inputs: string[];
  total: number;
}

interface RunSummaryCacheEntry {
  mtimeMs: number;
  size: number;
  summary: RunSummary;
}

// Capped at RUN_SUMMARY_CACHE_MAX entries so a long-running daemon that's produced thousands of
// runs doesn't grow this unboundedly; eviction is oldest-insertion-first (Map preserves insertion
// order, and every cache hit re-set()s its entry, which re-inserts it at the end, so this behaves
// like a simple LRU without a dedicated data structure).
const RUN_SUMMARY_CACHE_MAX = 500;
const runSummaryCache = new Map<string, RunSummaryCacheEntry>();
function cacheRunSummary(mp: string, entry: RunSummaryCacheEntry): void {
  runSummaryCache.delete(mp);
  runSummaryCache.set(mp, entry);
  while (runSummaryCache.size > RUN_SUMMARY_CACHE_MAX) {
    const oldest = runSummaryCache.keys().next().value;
    if (oldest === undefined) break;
    runSummaryCache.delete(oldest);
  }
}
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);
const TERMINAL_JOB_STATUSES = new Set(["ok", "error", "skipped", "cancelled"]);
const DEFAULT_STALE_RUN_MS = readDurationEnv("RUN_STALE_AFTER_MS", readDurationEnv("STALE_RUN_MS", 24 * 60 * 60 * 1000));
const DEFAULT_STALE_RUN_MESSAGE =
  "Run stopped before it finished. RēDesign was closed or restarted, so this run can no longer continue.";

function readDurationEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Monotonic per-process counter guarantees uniqueness even within the same ms.
let _seq = 0;

// Human-readable, sortable, collision-resistant run id:
//   20260608-174939-<hrtime><seq>[-label]
function newRunId(label?: string): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
  const ent = (process.hrtime.bigint() % 2176782336n).toString(36).padStart(6, "0"); // 6 base36 chars
  const seq = (_seq++).toString(36);
  const suffix = label ? `-${slugify(label).slice(0, 20)}` : "";
  return `${stamp}-${ent}${seq}${suffix}`;
}

// runDir/manifestPath are the single choke point every manifest read and write
// flows through, so they must validate the id here — otherwise a caller with an
// untrusted id (the GET /api/runs/:id and /events routes pass the raw route param)
// could escape OUTPUT_DIR via path traversal. resolveRunDir() rejects any id with
// a path separator, "."/".." or that resolves outside OUTPUT_DIR (400).
function runDir(runId: string): string {
  return resolveRunDir(runId);
}

function manifestPath(runId: string): string {
  return path.join(runDir(runId), "manifest.json");
}

interface StatusError extends Error {
  status?: number;
}

function statusError(message: string, status: number): StatusError {
  const err = new Error(message) as StatusError;
  err.status = status;
  return err;
}

function resolveRunDir(runId: unknown): string {
  const id = String(runId || "").trim();
  if (!id || id.includes("/") || id.includes("\\") || id === "." || id === "..") {
    throw statusError("invalid run id", 400);
  }
  try {
    return resolveInside(OUTPUT_DIR, id, { allowBaseItself: false, decode: false }).full;
  } catch (_) {
    throw statusError("invalid run id", 400);
  }
}

interface Job {
  status: string;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  [key: string]: unknown;
}

interface Counts {
  total: number;
  done: number;
  ok: number;
  error: number;
  skipped: number;
}

interface Manifest {
  runId: string;
  createdAt?: string;
  finishedAt?: string | null;
  status: string;
  summary?: unknown;
  config?: { modelIds?: string[]; inputIds?: string[]; [key: string]: unknown };
  jobs?: Job[];
  counts?: Counts;
  cost?: {
    totalCost: number;
    currency: string;
    jobCount: number;
    anyEstimatePricing: boolean;
    anyUnpriced: boolean;
  };
  error?: string | null;
  queue?: unknown;
  stale?: {
    previousStatus: string;
    markedAt: string;
    reason: string;
  };
  [key: string]: unknown;
}

function writeManifest(runId: string, manifest: Manifest): void {
  ensureDir(runDir(runId));
  const mp = manifestPath(runId);
  writeJSON(mp, manifest);
  try {
    const st = fs.statSync(mp);
    cacheRunSummary(mp, { mtimeMs: st.mtimeMs, size: st.size, summary: summarizeManifest(manifest, runId) });
  } catch (_) {
    runSummaryCache.delete(mp);
  }
}

interface ReadManifestOptions {
  activeRunIds?: Set<string> | Iterable<string> | null;
  staleAfterMs?: number;
  now?: Date | number;
  nowMs?: number;
  reason?: string;
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

function summarizeManifest(m: Manifest, fallbackRunId: string): RunSummary {
  return {
    runId: m.runId || fallbackRunId,
    createdAt: m.createdAt,
    finishedAt: m.finishedAt || null,
    status: m.status || "unknown",
    summary: m.summary || null,
    title: (m.summary as any) && (m.summary as any).title ? (m.summary as any).title : null,
    counts: m.counts || null,
    cost: m.cost,
    models: m.config ? (m.config.modelIds as string[]) : [],
    inputs: m.config ? (m.config.inputIds as string[]) : [],
    total: Array.isArray(m.jobs) ? m.jobs.length : 0,
  };
}

function toActiveRunSet(activeRunIds: ReadManifestOptions["activeRunIds"]): Set<string> | null {
  if (!activeRunIds) return null;
  if (activeRunIds instanceof Set) return activeRunIds;
  return new Set(Array.from(activeRunIds).map((id) => String(id)));
}

interface NormalizedStaleOptions {
  activeRunIds: Set<string> | null;
  staleAfterMs: number;
  nowMs: number;
  reason: string;
}

function normalizeStaleOptions(opts: ReadManifestOptions = {}): NormalizedStaleOptions {
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : Number(opts.now == null ? opts.nowMs : opts.now);
  return {
    activeRunIds: toActiveRunSet(opts.activeRunIds),
    staleAfterMs: Number.isFinite(opts.staleAfterMs) && (opts.staleAfterMs as number) >= 0 ? (opts.staleAfterMs as number) : DEFAULT_STALE_RUN_MS,
    nowMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
    reason: opts.reason || DEFAULT_STALE_RUN_MESSAGE,
  };
}

function timestampMs(value: unknown): number {
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? n : 0;
}

function manifestActivityMs(manifest: Manifest, st: fs.Stats | undefined): number {
  let latest = st && Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0;
  latest = Math.max(latest, timestampMs(manifest.createdAt), timestampMs(manifest.finishedAt));
  if (Array.isArray(manifest.jobs)) {
    for (const job of manifest.jobs) {
      latest = Math.max(latest, timestampMs(job?.startedAt), timestampMs(job?.finishedAt));
    }
  }
  return latest || 0;
}

function recountJobs(jobs: Job[] | undefined, previousCounts: Counts | undefined): Counts {
  const counts: Counts = { total: Array.isArray(jobs) ? jobs.length : previousCounts?.total || 0, done: 0, ok: 0, error: 0, skipped: 0 };
  if (!Array.isArray(jobs)) return counts;
  for (const job of jobs) {
    if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) continue;
    counts.done++;
    if (job.status === "ok") counts.ok++;
    else if (job.status === "error") counts.error++;
    else counts.skipped++;
  }
  return counts;
}

function settleStaleManifest(manifest: Manifest, fallbackRunId: string, options: ReadManifestOptions = {}): Manifest {
  const opts = normalizeStaleOptions(options);
  const staleAt = new Date(opts.nowMs).toISOString();
  const runId = manifest.runId || fallbackRunId;
  const jobs = Array.isArray(manifest.jobs)
    ? manifest.jobs.map((job) => {
        if (!job || TERMINAL_JOB_STATUSES.has(job.status)) return job;
        return {
          ...job,
          status: "error",
          error: job.error || opts.reason,
          finishedAt: job.finishedAt || staleAt,
        };
      })
    : manifest.jobs;

  return {
    ...manifest,
    runId,
    status: "error",
    finishedAt: manifest.finishedAt || staleAt,
    queue: null,
    error: manifest.error || opts.reason,
    stale: {
      previousStatus: manifest.status,
      markedAt: staleAt,
      reason: opts.reason,
    },
    jobs,
    counts: recountJobs(jobs, manifest.counts),
  };
}

function shouldSettleStaleManifest(runId: unknown, manifest: Manifest | null, st: fs.Stats | undefined, opts: NormalizedStaleOptions): boolean {
  if (!manifest || !ACTIVE_RUN_STATUSES.has(manifest.status)) return false;
  if (opts.activeRunIds?.has(String(runId || manifest.runId || ""))) return false;
  const lastActivity = manifestActivityMs(manifest, st);
  return opts.staleAfterMs === 0 || !lastActivity || opts.nowMs - lastActivity >= opts.staleAfterMs;
}

interface SettleResult {
  manifest: Manifest;
  stale: boolean;
  stat?: fs.Stats;
}

function maybeSettleStaleManifest(fallbackRunId: string, mp: string, manifest: Manifest, st: fs.Stats, opts: NormalizedStaleOptions): SettleResult {
  const runId = manifest.runId || fallbackRunId;
  if (!shouldSettleStaleManifest(runId, manifest, st, opts)) return { manifest, stale: false };
  const settled = settleStaleManifest(manifest, fallbackRunId, opts);
  writeJSON(mp, settled);
  let nextStat = st;
  try {
    nextStat = fs.statSync(mp);
    cacheRunSummary(mp, { mtimeMs: nextStat.mtimeMs, size: nextStat.size, summary: summarizeManifest(settled, fallbackRunId) });
  } catch (_) {
    runSummaryCache.delete(mp);
  }
  return { manifest: settled, stale: true, stat: nextStat };
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

export {
  OUTPUT_DIR,
  newRunId,
  runDir,
  manifestPath,
  writeManifest,
  readManifest,
  listRuns,
  settleStaleManifest,
  settleStaleRuns,
  deleteRun,
};
export type { Manifest, Job, Counts, RunSummary, ReadManifestOptions };
