/**
 * The light per-run summary the runs picker renders, plus the mtime+size-keyed cache that
 * keeps listRuns() from re-parsing every manifest on disk on each poll. The cache is a
 * module singleton on purpose: writeManifest, the stale sweep and the retention sweep all
 * have to invalidate the SAME map, so it must never be instantiated per caller.
 */
import type { Manifest, RunSummary } from "./types";

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

function summaryTitle(summary: unknown): string | null {
  if (summary && typeof summary === "object" && "title" in summary) {
    const title = (summary as { title?: unknown }).title;
    return title ? (title as string) : null;
  }
  return null;
}

// The run's thumbnail: the first input screenshot recorded in the manifest. Read off the
// manifest rather than the live input/ listing so a run keeps its thumbnail after the
// original screenshot is re-picked or renamed (a missing file just 404s the <img>).
function firstInputPreview(m: Manifest): string | null {
  const inputs = m.inputs as { preview?: unknown }[] | undefined;
  if (!Array.isArray(inputs)) return null;
  for (const input of inputs) {
    const preview = input?.preview;
    if (typeof preview === "string" && preview) return preview;
  }
  return null;
}

function summarizeManifest(m: Manifest, fallbackRunId: string): RunSummary {
  const queue = m.queue as { position?: unknown; held?: unknown } | null | undefined;
  return {
    runId: m.runId || fallbackRunId,
    createdAt: m.createdAt,
    finishedAt: m.finishedAt || null,
    status: m.status || "unknown",
    mock: !!m.mock,
    summary: m.summary || null,
    title: summaryTitle(m.summary),
    counts: m.counts || null,
    cost: m.cost,
    models: m.config ? (m.config.modelIds as string[]) : [],
    inputs: m.config ? (m.config.inputIds as string[]) : [],
    total: Array.isArray(m.jobs) ? m.jobs.length : 0,
    queueHeld: !!queue?.held,
    queuePosition: queue && typeof queue.position === "number" ? queue.position : null,
    thumb: typeof m.thumb === "string" && m.thumb ? m.thumb : null,
    preview: firstInputPreview(m),
  };
}

export { runSummaryCache, cacheRunSummary, summarizeManifest };
