/**
 * In-memory run registry + FIFO queue, SSE broadcast/heartbeat, and manifest bookkeeping for runs
 * started via the API. Ported from server/runQueue.js, the SSE transport itself moved into
 * routes/runs.ts (Hono's streamSSE), so this module now broadcasts through a small client
 * abstraction (an object with `write(payload)`) instead of writing directly to a raw
 * `http.ServerResponse`. Behavior (queue order, heartbeat interval, stale-run bookkeeping) is
 * preserved 1:1.
 */
import * as store from "../store";
import { runReimagine } from "../runner";
// `reference` arrives as untyped JSON off the wire; runReimagine validates the shape
// itself, so this only names the target type instead of widening the whole body to any.
import { readRunSpec, type RunSpec } from "../runner/run-spec";
import { getPreparedSummary, prepareRun, takePreparedRun, undoPreparedRun } from "./run-preflight";
import type { SelectionInput } from "../util";
// Lazy (dynamic) import, not a static one: auto-update.ts itself imports hasActiveRun from
// this module, so a static import here would create a module-init circular dependency.
// Deferring the require to call time (inside pumpRunQueue(), well after both modules have
// finished loading) avoids the cycle entirely while keeping the exact same behavior.
async function maybeApplyDeferredRestart(): Promise<boolean> {
  const { maybeApplyDeferredRestart: impl } = await import("../auto-update");
  return impl();
}

/** A subscriber that can receive raw SSE payload strings (`"data: ...\n\n"` etc). */
interface SseClient {
  write(payload: string): void;
}

interface RunBody {
  label?: string;
  preflightId?: string;
  maxCostUsd?: number;
  timeoutMs?: number;
  mock?: boolean;
  selfCheck?: boolean;
  inputs?: SelectionInput;
  models?: SelectionInput;
  prompts?: { presets?: unknown; custom?: string };
  variants?: number | string;
  modelQuantities?: Record<string, number | string>;
  maxImages?: number | string;
  concurrency?: number | string;
  poolConcurrency?: number | string;
  reference?: unknown;
  brandStyleGuide?: string | null;
  /**
   * Whether this submission may start on its own once the runner is free.
   *
   * Defaults to true, which is the behavior every non-browser caller (the MCP
   * tools, the CLI) has always relied on: POST and it runs. The control panel
   * sends false, because its two buttons are "Add to queue" and "Run queue" —
   * nothing it submits spends a key until the user presses the second one.
   */
  autoStart?: boolean;
  [key: string]: unknown;
}

interface RunEntry {
  clients: Set<SseClient>;
  controller: AbortController;
  lastManifest: store.Manifest | null;
  finished: boolean;
  status: "queued" | "running" | "finished";
  /** False while the run is parked in the queue waiting for an explicit "Run queue". */
  released: boolean;
  body: RunBody;
  spec: RunSpec;
  ownership: store.RunOwnershipClaim;
  heartbeat?: ReturnType<typeof setInterval>;
}

// In-memory registry of runs started via the API (for SSE + cancellation).
// API runs are FIFO: one active batch spends keys at a time, later submissions
// wait here and stream "queued" status until they reach the front.
const activeRuns = new Map<string, RunEntry>(); // runId -> entry
const runQueue: string[] = [];
let currentRunId: string | null = null;
const ORPHANED_RUN_MESSAGE = "Run stopped because RēDesign restarted before it finished.";

function runStoreOptions(options: store.ReadManifestOptions = {}): store.ReadManifestOptions {
  return { ...options, activeRunIds: new Set(activeRuns.keys()) };
}

function broadcast(runId: string, event: Record<string, unknown>): void {
  const entry = activeRuns.get(runId);
  if (!entry) return;
  if (event.manifest) entry.lastManifest = event.manifest as store.Manifest;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of entry.clients) {
    try {
      client.write(payload);
    } catch (_) {
      /* client gone */
    }
  }
}

function startHeartbeat(entry: RunEntry): void {
  entry.heartbeat = setInterval(() => {
    for (const client of entry.clients) {
      try {
        client.write(": ping\n\n");
      } catch (_) {
        entry.clients.delete(client);
      }
    }
  }, 25000);
  entry.heartbeat.unref?.();
}

const MAX_QUEUED_RUNS = 100;
const MAX_QUEUED_BYTES = 1024 * 1024 * 1024;

function queuedManifest(runId: string, spec: RunSpec, position: number, held = false): store.Manifest {
  return {
    runId, createdAt: spec.createdAt, finishedAt: null, status: "queued", mock: spec.settings.mock,
    summary: spec.label ? { title: spec.label, source: "label" } : null,
    specVersion: spec.version,
    config: {
      inputIds: spec.inputs.map((input) => input.id), modelIds: spec.models.map((model) => model.id),
      promptIds: spec.prompts.map((prompt) => prompt.id), ...spec.settings,
      reference: spec.referenceRels.length ? { images: spec.referenceRels, note: spec.referenceNote || null } : null,
      brandStyleGuide: spec.brandStyleGuide,
    },
    queue: { position, held }, inputs: spec.inputs, models: spec.models, prompts: spec.prompts,
    counts: { total: spec.jobs.length, done: 0, ok: 0, error: 0, skipped: 0 },
    jobs: structuredClone(spec.jobs), assets: spec.assets, assetBytes: spec.assetBytes,
    cost: { totalCost: 0, currency: "USD", jobCount: 0, anyEstimatePricing: false, anyUnpriced: false },
    providerCalls: [],
  };
}

function updateQueuedManifests(): void {
  runQueue.forEach((runId, idx) => {
    const entry = activeRuns.get(runId);
    if (entry?.status !== "queued") return;
    const existing = entry.lastManifest || queuedManifest(runId, entry.spec, idx + 1, !entry.released);
    const manifest: store.Manifest = {
      ...existing,
      status: "queued",
      queue: { position: idx + 1, held: !entry.released },
    };
    store.writeManifest(runId, manifest);
    broadcast(runId, { type: "snapshot", runId, manifest });
  });
}

/** Admission is synchronous after asset preparation: capacity, ownership and persistence
 * commit together before the pump can start work. Tokens make a lost response safe to retry. */
async function enqueueRun(body: RunBody): Promise<string> {
  const token = body.preflightId || (await prepareRun(body)).preflightId;
  const prepared = getPreparedSummary(token);
  if (prepared.runId) return prepared.runId;
  const waiting = [...activeRuns.values()].filter((entry) => !entry.finished);
  if (waiting.length >= MAX_QUEUED_RUNS) throw Object.assign(new Error("The queue is full (100 runs)."), { status: 429 });
  if (waiting.reduce((bytes, entry) => bytes + entry.spec.assetBytes, 0) + prepared.assetBytes > MAX_QUEUED_BYTES) {
    throw Object.assign(new Error("Queued run assets exceed 1 GiB."), { status: 413 });
  }
  const { runId, spec, reused } = takePreparedRun(token);
  if (reused) return runId;
  let ownership: store.RunOwnershipClaim | undefined;
  try {
    ownership = store.claimRunOwnership(runId);
    const entry: RunEntry = {
      clients: new Set(), controller: new AbortController(), lastManifest: null, finished: false,
      status: "queued", released: body.autoStart !== false, body: { ...body }, spec, ownership,
    };
    entry.lastManifest = queuedManifest(runId, spec, runQueue.length + 1, !entry.released);
    store.writeManifest(runId, entry.lastManifest);
    activeRuns.set(runId, entry);
    runQueue.push(runId);
    startHeartbeat(entry);
  } catch (error) {
    ownership?.release();
    undoPreparedRun(token, runId);
    throw error;
  }
  pumpRunQueue();
  return runId;
}

/**
 * Let every run currently parked in the queue start. Returns how many were waiting
 * on this, so the caller can say "running 3" rather than guess.
 *
 * Deliberately a snapshot of *now*: anything added after this returns is parked
 * again and needs its own release. That is what makes the control panel's "Add to
 * queue" label honest — a run never starts spending keys without a press behind it.
 */
function releaseQueue(): number {
  let released = 0;
  for (const runId of runQueue) {
    const entry = activeRuns.get(runId);
    if (!entry || entry.released || entry.status !== "queued") continue;
    entry.released = true;
    released++;
  }
  if (released) updateQueuedManifests();
  pumpRunQueue();
  return released;
}

/**
 * Reorder the waiting queue to follow `orderedIds`.
 *
 * Only runs that are queued RIGHT NOW can move — the currently-running run isn't in `runQueue`
 * (pumpRunQueue splices it out when it starts), so it can't be dragged and never appears here.
 * Any queued run omitted from `orderedIds` keeps its relative order after the named ones (so a
 * partial/stale list from the client can't drop runs). Rebroadcasts the new positions to every
 * subscriber and pumps once — a no-op unless a released run is now at the front. Held runs stay
 * held; this only changes the order they'll run in once released, which is the whole point of
 * dragging a parked queue. Returns the resulting order.
 */
function reorderQueue(orderedIds: unknown): { order: string[] } {
  const ids = (Array.isArray(orderedIds) ? orderedIds : []).map((id) => String(id || "").trim()).filter(Boolean);
  const queued = new Set(runQueue);
  const named: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (queued.has(id) && !seen.has(id)) {
      named.push(id);
      seen.add(id);
    }
  }
  const rest = runQueue.filter((id) => !seen.has(id));
  runQueue.length = 0;
  runQueue.push(...named, ...rest);
  updateQueuedManifests();
  pumpRunQueue();
  return { order: [...runQueue] };
}

/** How many runs are parked waiting for a release (for the control panel's button state). */
function heldRunCount(): number {
  let held = 0;
  for (const runId of runQueue) {
    const entry = activeRuns.get(runId);
    if (entry && !entry.released && entry.status === "queued") held++;
  }
  return held;
}

function pumpRunQueue(): void {
  if (currentRunId) return;
  // Drop entries that died while waiting (cancelled, or already finished), wherever they
  // sit. This used to fall out of shift()-ing them off the front; now that a held run can
  // sit in front of them, they have to be swept explicitly or they'd never be collected.
  for (let i = runQueue.length - 1; i >= 0; i--) {
    const queuedId = runQueue[i];
    const queued = queuedId ? activeRuns.get(queuedId) : undefined;
    if (!queued || queued.controller.signal.aborted || queued.finished) runQueue.splice(i, 1);
  }
  // Start the first *released* run. A held one keeps its place and is skipped rather than
  // consumed, so it still runs in submission order once a "Run queue" press reaches it.
  const idx = runQueue.findIndex((id) => activeRuns.get(id)?.released === true);
  if (idx !== -1) {
    const [runId] = runQueue.splice(idx, 1);
    const entry = runId ? activeRuns.get(runId) : undefined;
    if (runId && entry) {
      currentRunId = runId;
      entry.status = "running";
      try { updateQueuedManifests(); } catch (error) { console.warn("Could not persist remaining queue positions:", error); }
      runQueuedEntry(runId, entry);
      return;
    }
  }
  // Queue fully drained (nothing running, nothing waiting), a deferred auto-update restart
  // (see src/auto-update.ts) can now fire safely without interrupting an in-flight run.
  // Held runs count as waiting: restarting would orphan work the user has lined up.
  if (!runQueue.length) void maybeApplyDeferredRestart().catch((error) => console.warn("Deferred restart failed:", error));
}

function runQueuedEntry(runId: string, entry: RunEntry): void {
  runReimagine({
    runId, preparedSpec: entry.spec, ownership: entry.ownership,
    signal: entry.controller.signal, onProgress: (event) => broadcast(runId, event),
  })
    .then(() => {
      /* completion was already broadcast by runReimagine */
    })
    .catch((err: Error) => {
      const fallback = store.readManifest(runId) || entry.lastManifest || queuedManifest(runId, entry.spec, 0);
      const jobs = (fallback.jobs || []).map((job) => ["ok", "error", "skipped", "cancelled"].includes(job.status) ? job : { ...job, status: "error", error: err.message, finishedAt: new Date().toISOString() });
      const manifest: store.Manifest = {
        ...fallback,
        jobs,
        status: "error",
        finishedAt: new Date().toISOString(),
        error: err.message,
        queue: null,
      };
      try { store.writeManifest(runId, manifest); } catch (error) { console.warn(`Could not persist failed run ${runId}:`, error); }
      broadcast(runId, { type: "error", runId, message: err.message, manifest });
    })
    .finally(() => {
      entry.ownership.release();
      entry.finished = true;
      entry.status = "finished";
      if (currentRunId === runId) currentRunId = null;
      setTimeout(() => closeRun(runId), 2000);
      pumpRunQueue();
    });
}

function closeRun(runId: string): void {
  const entry = activeRuns.get(runId);
  if (!entry) return;
  if (entry.heartbeat) clearInterval(entry.heartbeat);
  for (const client of entry.clients) {
    try {
      (client as { close?: () => void }).close?.();
    } catch (_) {
      /* ignore */
    }
  }
  entry.ownership.release();
  activeRuns.delete(runId);
}

function cancelRun(runId: string): boolean {
  const entry = activeRuns.get(runId);
  if (!entry) {
    if (store.isRunOwned(runId)) throw Object.assign(new Error("This run is owned by another live process; cancel it there."), { status: 409 });
    return false;
  }
  if (entry.finished) return false;
  entry.controller.abort();
  if (entry.status === "queued") {
    const idx = runQueue.indexOf(runId);
    if (idx !== -1) runQueue.splice(idx, 1);
    const manifest: store.Manifest = {
      ...(entry.lastManifest || queuedManifest(runId, entry.spec, 0)),
      jobs: entry.spec.jobs.map((job) => ({ ...job, status: "cancelled", finishedAt: new Date().toISOString() })),
      counts: { total: entry.spec.jobs.length, done: entry.spec.jobs.length, ok: 0, error: 0, skipped: 0 },
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      queue: null,
    };
    store.writeManifest(runId, manifest);
    broadcast(runId, { type: "done", runId, manifest });
    entry.ownership.release();
    entry.finished = true;
    entry.status = "finished";
    setTimeout(() => closeRun(runId), 2000);
    updateQueuedManifests();
  }
  return true;
}

function normalizeRunDeleteIds(body: { ids?: unknown; id?: unknown } | null | undefined): string[] {
  const raw: unknown[] = Array.isArray(body?.ids) ? (body?.ids as unknown[]) : body?.id ? [body.id] : [];
  return Array.from(
    new Set(
      raw
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    ),
  );
}

interface DeleteRunsResult {
  deleted: string[];
  skipped: Array<{ runId: string; reason: string }>;
  runs: store.RunSummary[];
}

function deleteRuns(ids: string[]): DeleteRunsResult {
  const deleted: string[] = [];
  const skipped: Array<{ runId: string; reason: string }> = [];
  for (const runId of ids) {
    const entry = activeRuns.get(runId);
    if ((entry && !entry.finished) || store.isRunOwned(runId)) {
      skipped.push({ runId, reason: "run is still active" });
      continue;
    }
    const manifest = store.readManifest(runId, runStoreOptions());
    if (manifest && (manifest.status === "queued" || manifest.status === "running")) {
      skipped.push({ runId, reason: "run is still active" });
      continue;
    }
    try {
      store.deleteRun(runId);
      deleted.push(runId);
    } catch (err) {
      skipped.push({ runId, reason: err instanceof Error ? err.message : "delete failed" });
    }
  }
  return { deleted, skipped, runs: store.listRuns(runStoreOptions()) };
}

/** True while any run is queued or actively generating (excludes entries lingering
 *  in "finished" status during their 2s close-out window). Used to gate anything
 *  that must never interrupt an in-flight run, e.g. auto-update's self-relaunch. */
function hasActiveRun(): boolean {
  for (const entry of activeRuns.values()) {
    if (entry.status === "queued" || entry.status === "running") return true;
  }
  return store.listRuns().some((run) => (run.status === "running" || run.status === "queued") && store.isRunOwned(run.runId));
}

/** How one persisted queued run fared when recovery tried to adopt it. */
type QueueRecoveryOutcome =
  | { kind: "recovered"; assetBytes: number }
  | { kind: "skipped" }
  | { kind: "failed" };

/** Bytes every live entry has already claimed — the budget recovery has to fit inside. */
function activeAssetBytes(): number {
  return [...activeRuns.values()].reduce((total, entry) => total + entry.spec.assetBytes, 0);
}

/** Persisted queued runs in the order they were queued: saved position first, creation
 *  time as the tie-break, and a missing position sorted last so a half-written manifest
 *  cannot jump the line. */
function queuedRecoveryCandidates(): store.RunSummary[] {
  return store
    .listRuns()
    .filter((run) => run.status === "queued")
    .sort(
      (a, b) =>
        (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER) ||
        String(a.createdAt).localeCompare(String(b.createdAt)),
    );
}

/** Record that a saved queued run could not be adopted: its jobs are marked as needing an
 *  explicit retry, so it reads as actionable rather than merely stalled. */
function recordQueuedRecoveryFailure(runId: string, error: unknown): void {
  const existing = store.readManifest(runId);
  if (!existing) return;
  const jobs = (existing.jobs || []).map((job) => ({ ...job, status: "error", error: "Queue recovery requires an explicit retry." }));
  store.writeManifest(runId, { ...existing, status: "error", jobs, counts: { total: jobs.length, done: jobs.length, ok: 0, error: jobs.length, skipped: 0 }, queue: null, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
}

/** Claim one persisted queued run and park it here as held.
 *
 *  "skipped" means recovery did not take it on — another live process owns it, the claim
 *  was lost, or it stopped being queued underneath us; nothing was written. "failed" means
 *  it was claimed but its saved recipe is unusable, and the error manifest is already
 *  persisted. `bytes` is the running total the new entry must fit alongside. */
function adoptQueuedRun(runId: string, bytes: number): QueueRecoveryOutcome {
  let ownership: store.RunOwnershipClaim;
  try {
    ownership = store.claimRunOwnership(runId);
  } catch (_) {
    return { kind: "skipped" };
  }
  try {
    const existing = store.readManifest(runId);
    if (existing?.status !== "queued") {
      ownership.release();
      return { kind: "skipped" };
    }
    const spec = readRunSpec(store.runDir(runId));
    if (!spec) throw new Error("Queued run cannot be recovered: its saved specification or assets are missing or corrupt.");
    if (activeRuns.size >= MAX_QUEUED_RUNS || bytes + spec.assetBytes > MAX_QUEUED_BYTES) {
      throw new Error("Queue recovery reached its resource limit; retry this saved run after the queue drains.");
    }
    const entry: RunEntry = {
      clients: new Set(), controller: new AbortController(), lastManifest: existing, finished: false,
      status: "queued", released: false, body: { autoStart: false }, spec, ownership,
    };
    activeRuns.set(runId, entry);
    runQueue.push(runId);
    startHeartbeat(entry);
    return { kind: "recovered", assetBytes: spec.assetBytes };
  } catch (error) {
    recordQueuedRecoveryFailure(runId, error);
    ownership.release();
    return { kind: "failed" };
  }
}

/** Recover persisted recipes, including previously released waiting work, as held.
 * Ownership prevents a second daemon from adopting another process's live queue. */
function recoverQueuedRuns(): number {
  let recovered = 0;
  let bytes = activeAssetBytes();
  for (const run of queuedRecoveryCandidates()) {
    if (activeRuns.has(run.runId) || store.isRunOwned(run.runId)) continue;
    const outcome = adoptQueuedRun(run.runId, bytes);
    if (outcome.kind === "recovered") {
      bytes += outcome.assetBytes;
      recovered++;
    }
  }
  updateQueuedManifests();
  return recovered;
}

export {
  activeRuns,
  runStoreOptions,
  ORPHANED_RUN_MESSAGE,
  enqueueRun,
  recoverQueuedRuns,
  releaseQueue,
  reorderQueue,
  heldRunCount,
  cancelRun,
  normalizeRunDeleteIds,
  deleteRuns,
  hasActiveRun,
};
export type { SseClient, RunBody, RunEntry, DeleteRunsResult };
