import { watch } from 'vue';
import { toast } from 'vue-sonner';
import { api, ApiError, eventsUrl } from '@/lib/api';
import { t } from '@/i18n';
import type { Manifest, RunEvent, RunRequest, RunSummary } from '@/types';
import { errMessage, isActiveStatus } from './state';
import type { ControlState } from './state';

export interface RunsDeps {
  refreshKeys: () => Promise<void>;
}

// ── Undo window for run deletion ──────────────────────────────────────────────
// Deleting a run's outputs is irrecoverable server-side (rmSync), so the confirm
// click here only *optimistically* hides the run and arms a timer; the real
// DELETE only fires once the window elapses without an Undo. If the tab closes
// or navigates away mid-window, `flushPendingDeletes` fires the delete via
// `sendBeacon` so it isn't silently lost.
const UNDO_WINDOW_MS = 6000;
const DELETE_URL = '/api/runs/delete';

interface PendingDelete {
  ids: string[];
  runs: RunSummary[]; // removed rows
  snapshot: RunSummary[]; // full pre-delete list, so Undo restores the original order
  timer: ReturnType<typeof setTimeout>;
}

const pendingDeletes = new Set<PendingDelete>();

function beaconDelete(ids: string[]) {
  const body = JSON.stringify({ ids });
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    const ok = navigator.sendBeacon(DELETE_URL, new Blob([body], { type: 'application/json' }));
    if (ok) return;
  }
  // Best-effort fallback (older browsers / beacon rejected the payload), keepalive
  // lets the request outlive the unloading document for a short grace period.
  void fetch(DELETE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
}

/** Fire every still-pending delete immediately (page close / navigation away). Never awaited. */
export function flushPendingDeletes() {
  for (const pending of pendingDeletes) {
    clearTimeout(pending.timer);
    pendingDeletes.delete(pending);
    beaconDelete(pending.ids);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushPendingDeletes);
  window.addEventListener('pagehide', flushPendingDeletes);
}

// Debounce ms for the pre-run cost estimate: selection changes (toggling a model,
// bumping variants) can fire several times in quick succession, and each call is a
// round trip that scans recent runs server-side, coalesce into one request.
const ESTIMATE_DEBOUNCE_MS = 300;

export function createRunsActions(state: ControlState, deps: RunsDeps) {
  let estimateTimer: ReturnType<typeof setTimeout> | null = null;
  let estimateSeq = 0;

  // ── Live run subscriptions ──────────────────────────────────────────────────
  // One SSE stream per tracked run, not one global stream. The server has always
  // accepted a second run while one is in flight and streams it as `queued` with a
  // position (src/http/runQueue.ts), so a client that only ever watched a single
  // stream was the reason a queue was invisible. A stream per run means the backlog
  // reports its position live, and re-subscribing after a refresh re-attaches to
  // whatever is still going (the server replays its last manifest as a snapshot).
  const sources = new Map<string, EventSource>();

  function unsubscribe(runId: string): void {
    const es = sources.get(runId);
    if (!es) return;
    sources.delete(runId);
    try {
      es.close();
    } catch {
      /* already closed */
    }
  }

  function subscribe(runId: string): void {
    if (sources.has(runId) || typeof EventSource === 'undefined') return;
    const es = new EventSource(eventsUrl(runId));
    sources.set(runId, es);
    es.onmessage = (e: MessageEvent<string>) => handleEvent(runId, e.data);
    // No onerror handler on purpose: EventSource reconnects on its own using the
    // server's `retry: 3000`, and a reconnect to a finished run just replays its
    // final manifest as `done`, which unsubscribes us below.
  }

  function handleEvent(runId: string, raw: string): void {
    if (!raw) return;
    let ev: RunEvent;
    try {
      ev = JSON.parse(raw) as RunEvent;
    } catch {
      return;
    }
    if (ev.type === 'start' || ev.type === 'snapshot') {
      ingestManifest(ev.manifest);
    } else if (ev.type === 'job') {
      const entry = state.trackRun(runId);
      entry.jobs.set(ev.job.id, ev.job);
      entry.status = 'running';
      entry.queuePosition = null;
    } else if (ev.type === 'done') {
      ingestManifest(ev.manifest);
      finishRun(runId, ev.manifest && ev.manifest.status);
    } else if (ev.type === 'error') {
      toast.error(t('runs.error'), { description: ev.message });
      finishRun(runId, 'error');
    }
  }

  async function refreshRuns() {
    try {
      state.runs.value = await api.runs();
    } catch {
      /* non-fatal */
    }
  }

  /** Immediate (non-debounced) pre-run cost estimate fetch. Prefer `scheduleCostEstimate`. */
  async function refreshCostEstimate() {
    const modelIds = [...state.selModels.value];
    const jobCount = state.estimate.value.count;
    if (!modelIds.length || !jobCount) {
      state.costEstimate.value = null;
      return;
    }
    // Per-model job counts so the estimate honors each model's own quantity
    // (inputs × prompts × that model's copies) instead of an even split.
    const nP = state.selPrompts.value.length + (state.customOn.value && state.custom.value.trim() ? 1 : 0);
    const base = state.selInputs.value.length * nP;
    const jobCountByModel: Record<string, number> = {};
    for (const id of modelIds) jobCountByModel[id] = base * Math.max(1, state.modelQty.value[id] || 1);
    const seq = ++estimateSeq;
    state.costEstimateLoading.value = true;
    try {
      const result = await api.estimateRunCost({ modelIds, jobCount, jobCountByModel });
      if (seq === estimateSeq) state.costEstimate.value = result;
    } catch {
      if (seq === estimateSeq) state.costEstimate.value = null;
    } finally {
      if (seq === estimateSeq) state.costEstimateLoading.value = false;
    }
  }

  /** Debounced entry point, call on every selection/option change. */
  function scheduleCostEstimate() {
    if (estimateTimer) clearTimeout(estimateTimer);
    estimateTimer = setTimeout(() => void refreshCostEstimate(), ESTIMATE_DEBOUNCE_MS);
  }

  watch(
    () => [
      state.selInputs.value.length,
      [...state.selModels.value].sort().join(','),
      state.estimate.value.count,
      JSON.stringify(state.modelQty.value),
    ],
    scheduleCostEstimate,
    { immediate: true },
  );

  /** Actually call the server delete once the undo window elapses uninterrupted. */
  async function commitDelete(pending: PendingDelete) {
    pendingDeletes.delete(pending);
    try {
      const r = await api.deleteRuns(pending.ids);
      // Reconcile with server truth. A run may have failed to delete server-side
      // (e.g. still locked), put those rows back so they aren't silently lost.
      state.runs.value = r.runs || state.runs.value.filter((run) => !r.deleted.includes(run.runId));
      if (r.skipped.length) {
        const skippedRuns = pending.runs.filter((run) => r.skipped.some((s) => s.runId === run.runId));
        if (skippedRuns.length) {
          state.runs.value = mergeRuns(state.runs.value, skippedRuns);
        }
        const first = r.skipped[0];
        const firstReason = first?.reason || t('runs.deleteFallbackReason');
        const message =
          r.skipped.length === 1
            ? t('runs.deleteOneFailed', { run: first?.runId || t('runs.runFallback'), reason: firstReason })
            : t('runs.skippedMany', { count: r.skipped.length, reason: firstReason }, r.skipped.length);
        if (r.deleted.length) toast(message);
        else toast.error(message);
      }
    } catch (e) {
      // Delete never happened, restore the rows so nothing is lost from view.
      state.runs.value = mergeRuns(state.runs.value, pending.runs);
      if (e instanceof ApiError && e.status === 404) {
        toast.error(t('runs.deleteNeedsRestart'));
      } else {
        toast.error(t('runs.deleteFailed'), { description: errMessage(e) });
      }
    }
  }

  /**
   * Re-insert previously-removed rows. Prefers `pending.snapshot`'s original
   * ordering/positions; any row from `restored` not found there (e.g. the list
   * was refreshed from the server meanwhile) is appended.
   */
  function mergeRuns(current: RunSummary[], restored: RunSummary[], snapshot?: RunSummary[]) {
    const known = new Set(current.map((run) => run.runId));
    const toAdd = restored.filter((run) => !known.has(run.runId));
    if (!toAdd.length) return current;
    if (!snapshot) return [...current, ...toAdd];
    const restoredIds = new Set(toAdd.map((run) => run.runId));
    const out: RunSummary[] = [];
    const currentById = new Map(current.map((run) => [run.runId, run]));
    for (const run of snapshot) {
      if (currentById.has(run.runId)) out.push(currentById.get(run.runId)!);
      else if (restoredIds.has(run.runId)) out.push(run);
    }
    // Anything in `current` that wasn't part of the original snapshot (e.g. a new
    // run that started mid-window) stays appended at the end, after position.
    for (const run of current) if (!snapshot.some((s) => s.runId === run.runId)) out.push(run);
    return out;
  }

  /**
   * Optimistically hide `ids` and arm the undo window; the real API delete only
   * fires once the window elapses uninterrupted (see `commitDelete`). Resolves
   * immediately with a synthetic "fully deleted" response so existing callers
   * (RunFlyout selection cleanup, ViewSettings' away-navigation) behave the same
   * as the old synchronous delete.
   */
  async function deleteRuns(ids: string[]) {
    const uniqueIds = Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
    if (!uniqueIds.length) return null;

    const snapshot = state.runs.value;
    const removed = snapshot.filter((run) => uniqueIds.includes(run.runId));
    state.runs.value = snapshot.filter((run) => !uniqueIds.includes(run.runId));

    // Drop the progress card for anything being deleted so it can't outlive its run.
    // Only for runs that have FINISHED: the server refuses to delete an active one
    // (runQueue.ts deleteRuns), and tearing its stream down here optimistically
    // would strand a run that keeps generating with nothing listening to it.
    const focusedBefore = state.focusedRunId.value;
    for (const id of uniqueIds) {
      const tracked = state.trackedRuns.get(id);
      if (tracked && isActiveStatus(tracked.status)) continue;
      unsubscribe(id);
      state.untrackRun(id);
    }

    const pending: PendingDelete = {
      ids: uniqueIds,
      runs: removed,
      snapshot,
      timer: setTimeout(() => void commitDelete(pending), UNDO_WINDOW_MS),
    };
    pendingDeletes.add(pending);

    toast(t('runs.pendingDelete', { count: uniqueIds.length }, uniqueIds.length), {
      duration: UNDO_WINDOW_MS,
      action: {
        label: t('runs.undo'),
        onClick: () => {
          if (!pendingDeletes.has(pending)) return; // already committed/flushed
          clearTimeout(pending.timer);
          pendingDeletes.delete(pending);
          state.runs.value = mergeRuns(state.runs.value, pending.runs, pending.snapshot);
          // Undo restores the row *and* the progress card the user was looking at.
          if (focusedBefore && uniqueIds.includes(focusedBefore) && !state.trackedRuns.has(focusedBefore)) {
            void api
              .run(focusedBefore)
              .then((m) => {
                ingestManifest(m);
                // Re-attach if it turns out the run is still going, so the restored
                // card streams instead of freezing on the manifest we just fetched.
                if (isActiveStatus(m?.status)) subscribe(focusedBefore);
                focusRun(focusedBefore);
              })
              .catch(() => {
                /* row is back; the card just stays closed */
              });
          }
          toast(t('runs.restored', { count: pending.ids.length }, pending.ids.length));
        },
      },
    });

    return { deleted: uniqueIds, skipped: [], runs: state.runs.value };
  }

  function ingestManifest(m: Manifest | null | undefined) {
    if (!m || !m.runId) return;
    const entry = state.trackRun(m.runId);
    entry.queuePosition = m.queue && m.queue.position ? m.queue.position : null;
    entry.total = (m.counts && m.counts.total) || (m.jobs ? m.jobs.length : entry.total);
    if (m.summary && m.summary.title) entry.title = m.summary.title;
    entry.status = m.status;
    if (m.jobs) for (const j of m.jobs) entry.jobs.set(j.id, j);
  }

  /** Point the progress card at a tracked run (or clear it). */
  function focusRun(runId: string | null) {
    state.focusedRunId.value = runId;
  }

  function finishRun(runId: string, status?: string | null) {
    unsubscribe(runId);
    const entry = state.trackedRuns.get(runId);
    if (entry) entry.queuePosition = null;
    if (entry && isActiveStatus(entry.status)) entry.status = status || 'done';
    deps.refreshKeys();
    refreshRuns();
    // Hand the card to whatever was queued behind this run, so a batch of queued
    // runs walks forward on its own instead of stranding the user on a dead card.
    if (state.focusedRunId.value === runId) {
      const next = state.backlogRuns.value[0];
      if (next) focusRun(next.runId);
    }
    if (status === 'cancelled') toast(t('runs.cancelled'));
    else if (status === 'error') toast.error(t('runs.failed'));
    else toast.success(t('runs.finished'));
  }

  /**
   * Re-attach after a reload. The server keeps running with the browser closed and
   * writes every run's manifest to disk, so anything still queued/running is picked
   * back up live, and the last run being watched is restored read-only if it ended
   * while the tab was away.
   */
  async function resumeRuns() {
    const remembered = state.focusedRunId.value;
    for (const summary of state.runs.value) {
      if (!isActiveStatus(summary.status)) continue;
      // bootstrap() runs again on every Control remount, and this summary list is
      // read from disk — staler than what SSE has already pushed into a run we are
      // streaming. Seed a run only the first time; after that the stream owns it.
      if (!sources.has(summary.runId)) {
        state.trackRun(summary.runId, {
          title: summary.title || summary.summary?.title || summary.runId,
          status: summary.status,
          total: summary.counts?.total ?? summary.total ?? 0,
        });
      }
      subscribe(summary.runId);
    }
    // What to show: the run being watched if it's still going, else whatever is
    // generating now (more useful than a finished card), else the remembered run
    // restored from disk — that last case is the "I refreshed and lost it" fix.
    if (remembered && state.trackedRuns.has(remembered)) return;
    const live = state.activeRuns.value[0];
    if (live) return focusRun(live.runId);
    if (!remembered) return;
    if (!state.runs.value.some((r) => r.runId === remembered)) return focusRun(null); // deleted since
    try {
      const manifest = await api.run(remembered);
      ingestManifest(manifest);
      // The run list is a disk read and can lag the runner by a beat, so a run it
      // reported as finished may still be going. Attach if this fresher read says so.
      if (isActiveStatus(manifest?.status)) subscribe(remembered);
    } catch {
      focusRun(null);
    }
  }

  async function startRun() {
    if (!state.selInputs.value.length) return toast(t('runs.pickInput'));
    if (!state.selModels.value.length) return toast(t('runs.pickModel'));
    if (!state.selPrompts.value.length && !(state.customOn.value && state.custom.value.trim()))
      return toast(t('runs.pickPrompt'));

    // Only send quantities that differ from the default of 1; the backend defaults
    // every other selected model to a single copy.
    const modelQuantities: Record<string, number> = {};
    for (const id of state.selModels.value) {
      const q = state.modelQty.value[id];
      if (q && q > 1) modelQuantities[id] = q;
    }

    const body: RunRequest = {
      inputs: { ids: [...state.selInputs.value] },
      models: { ids: [...state.selModels.value] },
      prompts: {
        presets: [...state.selPrompts.value],
        custom: state.customOn.value ? state.custom.value.trim() || null : null,
      },
      maxImages: Math.max(1, state.maxImages.value || 8),
      mock: state.mock.value,
    };
    if (Object.keys(modelQuantities).length) body.modelQuantities = modelQuantities;
    if (state.referenceOn.value && state.selReference.value.length) {
      body.reference = { images: [...state.selReference.value], note: state.refNote.value.trim() || null };
    }
    if (state.brandOn.value) {
      const guideText = state.brandStyleGuide.value.trim();
      const attachmentBlocks = state.brandAttachments.value.map(
        (a) => `\n\n--- Attachment: ${a.name} ---\n${a.text}`,
      );
      const combined = [guideText, ...attachmentBlocks].join('').trim();
      if (combined) body.brandStyleGuide = combined;
    }

    // Runs already in flight stay tracked: the server queues this one behind them
    // and streams its position, so the queue builds up instead of being refused.
    const queuedBehind = state.activeRuns.value.length;
    state.submitting.value = true;
    try {
      const { runId: id } = await api.startRun(body);
      state.trackRun(id, { title: id, status: 'queued', total: 0 });
      subscribe(id);
      // Watch the newest submission unless something is already generating — then
      // stay on the live run and let the backlog strip show what's behind it.
      if (!queuedBehind) focusRun(id);
      refreshRuns();
      toast(queuedBehind ? t('runs.queuedBehind', { count: queuedBehind }, queuedBehind) : t('runs.queued'));
    } catch (e) {
      toast.error(t('runs.startFailed'), { description: errMessage(e) });
    } finally {
      state.submitting.value = false;
    }
  }

  async function cancelRun(runId?: string) {
    const id = runId || state.focusedRunId.value;
    if (!id) return;
    try {
      await api.cancelRun(id);
    } catch (e) {
      toast.error(t('runs.cancelFailed'), { description: errMessage(e) });
    }
  }

  return {
    refreshRuns,
    deleteRuns,
    startRun,
    cancelRun,
    focusRun,
    resumeRuns,
    refreshCostEstimate,
    scheduleCostEstimate,
  };
}
