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
import { normalizeSelectionIds, type SelectionInput } from "../util";
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
  mock?: boolean;
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
  [key: string]: unknown;
}

interface RunEntry {
  clients: Set<SseClient>;
  controller: AbortController;
  lastManifest: store.Manifest | null;
  finished: boolean;
  status: "queued" | "running" | "finished";
  body: RunBody;
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

function selectedIds(selection: SelectionInput): string[] {
  return normalizeSelectionIds(selection, { extraKeys: ["ids", "presets"] });
}

function queuedManifest(runId: string, body: RunBody, position: number): store.Manifest {
  const prompts = body.prompts || {};
  const promptIds = selectedIds(prompts as SelectionInput);
  if (prompts.custom) promptIds.push("custom");
  return {
    runId,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    status: "queued",
    mock: !!body.mock,
    summary: body.label ? { title: String(body.label).trim(), source: "label" } : null,
    config: {
      inputIds: selectedIds(body.inputs || "all"),
      modelIds: selectedIds(body.models || "all"),
      promptIds,
      variants: Math.max(1, Number.parseInt(String(body.variants), 10) || 1),
      maxImagesPerInput: Math.max(1, Number.parseInt(String(body.maxImages), 10) || 8),
      concurrency: body.concurrency || null,
      poolConcurrency: body.poolConcurrency || null,
      reference: body.reference || null,
    },
    queue: { position },
    inputs: [],
    prompts: [],
    models: [],
    counts: { total: 0, done: 0, ok: 0, error: 0, skipped: 0 },
    jobs: [],
  };
}

function updateQueuedManifests(): void {
  runQueue.forEach((runId, idx) => {
    const entry = activeRuns.get(runId);
    if (!entry || entry.status !== "queued") return;
    const existing = entry.lastManifest || queuedManifest(runId, entry.body || {}, idx + 1);
    const manifest: store.Manifest = { ...existing, status: "queued", queue: { position: idx + 1 } };
    store.writeManifest(runId, manifest);
    broadcast(runId, { type: "snapshot", runId, manifest });
  });
}

function enqueueRun(body: RunBody): string {
  const runId = store.newRunId(body.label);
  const controller = new AbortController();
  const entry: RunEntry = {
    clients: new Set(),
    controller,
    lastManifest: null,
    finished: false,
    status: "queued",
    body,
  };
  activeRuns.set(runId, entry);
  startHeartbeat(entry);

  runQueue.push(runId);
  entry.lastManifest = queuedManifest(runId, body, runQueue.length);
  store.writeManifest(runId, entry.lastManifest);
  updateQueuedManifests();
  pumpRunQueue();

  return runId;
}

function pumpRunQueue(): void {
  if (currentRunId) return;
  while (runQueue.length) {
    const runId = runQueue.shift() as string;
    const entry = activeRuns.get(runId);
    if (!entry || entry.controller.signal.aborted || entry.finished) continue;
    currentRunId = runId;
    entry.status = "running";
    updateQueuedManifests();
    runQueuedEntry(runId, entry);
    return;
  }
  // Queue fully drained (nothing running, nothing waiting), a deferred auto-update restart
  // (see src/auto-update.ts) can now fire safely without interrupting an in-flight run.
  void maybeApplyDeferredRestart();
}

function runQueuedEntry(runId: string, entry: RunEntry): void {
  const body = entry.body || {};
  runReimagine({
    runId,
    inputs: body.inputs || "all",
    models: body.models || "all",
    prompts: body.prompts || {},
    reference: (body.reference as any) || null,
    brandStyleGuide: typeof body.brandStyleGuide === "string" ? body.brandStyleGuide : null,
    variants: body.variants || 1,
    modelQuantities: body.modelQuantities || undefined,
    mock: !!body.mock,
    concurrency: body.concurrency,
    poolConcurrency: body.poolConcurrency,
    maxImagesPerInput: body.maxImages,
    label: body.label,
    signal: entry.controller.signal,
    onProgress: (ev) => broadcast(runId, ev),
  })
    .then(() => {
      /* completion was already broadcast by runReimagine */
    })
    .catch((err: Error) => {
      const fallback = entry.lastManifest || queuedManifest(runId, body, 0);
      const manifest: store.Manifest = {
        ...fallback,
        status: "error",
        finishedAt: new Date().toISOString(),
        error: err.message,
        queue: null,
      };
      store.writeManifest(runId, manifest);
      broadcast(runId, { type: "error", runId, message: err.message, manifest });
    })
    .finally(() => {
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
  activeRuns.delete(runId);
}

function cancelRun(runId: string): boolean {
  const entry = activeRuns.get(runId);
  if (!entry) return false;
  entry.controller.abort();
  if (entry.status === "queued") {
    const idx = runQueue.indexOf(runId);
    if (idx !== -1) runQueue.splice(idx, 1);
    const manifest: store.Manifest = {
      ...(entry.lastManifest || queuedManifest(runId, entry.body || {}, 0)),
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      queue: null,
    };
    store.writeManifest(runId, manifest);
    broadcast(runId, { type: "done", runId, manifest });
    entry.finished = true;
    entry.status = "finished";
    setTimeout(() => closeRun(runId), 2000);
    updateQueuedManifests();
  }
  return true;
}

function normalizeRunDeleteIds(body: { ids?: unknown; id?: unknown } | null | undefined): string[] {
  const raw: unknown[] = Array.isArray(body?.ids) ? (body!.ids as unknown[]) : body?.id ? [body.id] : [];
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
    if (entry && !entry.finished) {
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
  return false;
}

export {
  activeRuns,
  runStoreOptions,
  ORPHANED_RUN_MESSAGE,
  enqueueRun,
  cancelRun,
  normalizeRunDeleteIds,
  deleteRuns,
  hasActiveRun,
};
export type { SseClient, RunBody, RunEntry, DeleteRunsResult };
