/**
 * Settling ORPHANED runs. A run whose daemon died mid-flight stays "running" in its manifest
 * forever, so anything that reads a manifest first asks whether it has gone quiet for longer
 * than the stale window and, if so, rewrites it as an error with its unfinished jobs closed
 * out. A run the caller says is genuinely still active is always left alone.
 */
import fs from "node:fs";
import { writeJSON } from "../util";
import { ACTIVE_RUN_STATUSES, TERMINAL_JOB_STATUSES } from "./types";
import type { Counts, Job, Manifest, ReadManifestOptions } from "./types";
import { cacheRunSummary, runSummaryCache, summarizeManifest } from "./summary";

function readDurationEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const DEFAULT_STALE_RUN_MS = readDurationEnv("RUN_STALE_AFTER_MS", readDurationEnv("STALE_RUN_MS", 24 * 60 * 60 * 1000));
const DEFAULT_STALE_RUN_MESSAGE =
  "Run stopped before it finished. RēDesign was closed or restarted, so this run can no longer continue.";

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
  // Compact, same as writeManifest: every writer of manifest.json has to agree on the format, or
  // settling an orphaned run silently re-inflates the largest manifests we have.
  writeJSON(mp, settled, { pretty: false });
  let nextStat = st;
  try {
    nextStat = fs.statSync(mp);
    cacheRunSummary(mp, { mtimeMs: nextStat.mtimeMs, size: nextStat.size, summary: summarizeManifest(settled, fallbackRunId) });
  } catch (_) {
    runSummaryCache.delete(mp);
  }
  return { manifest: settled, stale: true, stat: nextStat };
}

export {
  normalizeStaleOptions,
  manifestActivityMs,
  settleStaleManifest,
  shouldSettleStaleManifest,
  maybeSettleStaleManifest,
};
export type { NormalizedStaleOptions };
