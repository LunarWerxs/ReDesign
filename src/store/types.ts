/**
 * The run-store vocabulary: the on-disk manifest shape, the light summary the runs picker
 * reads, and the two status sets every other slice branches on. Deliberately dependency-free
 * (no fs, no paths) so every other module under src/store/ can import it without a cycle.
 */

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

interface RunSummary {
  runId: string;
  createdAt?: string;
  finishedAt: string | null;
  status: string;
  mock: boolean;
  summary: unknown;
  title: string | null;
  counts: unknown;
  cost?: Manifest["cost"];
  models: string[];
  inputs: string[];
  total: number;
  /**
   * Queue state for a still-queued run, mirrored from the manifest's `queue` block so a client
   * that RESUMES from this summary (after a reload) can tell a PARKED batch (held: true, waiting
   * for a "Run queue" press) from a RELEASED one that's about to start. Without it the client
   * defaulted every resumed queued run to not-held and briefly mis-drew the run button as "queue
   * is live". Null/absent once the run leaves the queue (running/done/etc).
   */
  queueHeld: boolean;
  queuePosition: number | null;
  /**
   * The run's own durable thumbnail, relative to its run directory (served as
   * /output/<runId>/<thumb>). Written at run start by runner/reimagine.ts's
   * persistRunThumbnail. Null for runs that predate it, or when the copy failed.
   */
  thumb: string | null;
  /**
   * Fallback thumbnail: the run's first input screenshot, relative to input/. Only useful
   * while that file still exists — input/ is routinely emptied, which is exactly why `thumb`
   * above was added. Null for a run whose manifest has no inputs yet (still queued).
   */
  preview: string | null;
}

interface ReadManifestOptions {
  activeRunIds?: Set<string> | Iterable<string> | null;
  staleAfterMs?: number;
  now?: Date | number;
  nowMs?: number;
  reason?: string;
}

interface PruneRunsResult {
  deleted: string[];
  freedBytes: number;
}

// "Still going" vs "will never change again". ACTIVE_RUN_STATUSES gates stale-settling and
// retention (an active run is never touched); TERMINAL_JOB_STATUSES gates the job recount.
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);
const TERMINAL_JOB_STATUSES = new Set(["ok", "error", "skipped", "cancelled"]);

interface StatusError extends Error {
  status?: number;
}

function statusError(message: string, status: number): StatusError {
  const err = new Error(message) as StatusError;
  err.status = status;
  return err;
}

export { statusError, ACTIVE_RUN_STATUSES, TERMINAL_JOB_STATUSES };
export type { Job, Counts, Manifest, RunSummary, ReadManifestOptions, PruneRunsResult, StatusError };
