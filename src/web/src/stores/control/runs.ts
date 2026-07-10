import { ref, watch } from 'vue';
import { useEventSource } from '@vueuse/core';
import { toast } from 'vue-sonner';
import { api, ApiError, eventsUrl } from '@/lib/api';
import { t } from '@/i18n';
import type { Manifest, RunEvent, RunRequest, RunSummary } from '@/types';
import { errMessage } from './state';
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
  const sourceUrl = ref<string>();
  let estimateTimer: ReturnType<typeof setTimeout> | null = null;
  let estimateSeq = 0;
  const { data, close } = useEventSource(sourceUrl, [], {
    autoReconnect: { retries: -1, delay: 2500 },
    immediate: false,
  });

  watch(data, (raw) => {
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
      state.jobs.set(ev.job.id, ev.job);
      state.runStatus.value = 'running';
    } else if (ev.type === 'done') {
      ingestManifest(ev.manifest);
      finishRun(ev.manifest && ev.manifest.status);
    } else if (ev.type === 'error') {
      toast.error(t('runs.error'), { description: ev.message });
      finishRun('error');
    }
  });

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
    const seq = ++estimateSeq;
    state.costEstimateLoading.value = true;
    try {
      const result = await api.estimateRunCost({ modelIds, jobCount });
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
    () => [state.selInputs.value.length, [...state.selModels.value].sort().join(','), state.estimate.value.count],
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
          toast(t('runs.restored', { count: pending.ids.length }, pending.ids.length));
        },
      },
    });

    return { deleted: uniqueIds, skipped: [], runs: state.runs.value };
  }

  function ingestManifest(m: Manifest) {
    if (!m) return;
    state.queuePosition.value = m.queue && m.queue.position ? m.queue.position : null;
    state.total.value = (m.counts && m.counts.total) || (m.jobs ? m.jobs.length : state.total.value);
    if (m.summary && m.summary.title && m.runId === state.runId.value) state.runTitle.value = m.summary.title;
    state.runStatus.value = m.status;
    if (m.jobs) for (const j of m.jobs) state.jobs.set(j.id, j);
  }

  function subscribe(id: string) {
    state.jobs.clear();
    state.queuePosition.value = null;
    state.total.value = 0;
    sourceUrl.value = eventsUrl(id);
    // The server closes the stream when the run ends; that's expected, stay silent.
  }

  function finishRun(status?: string | null) {
    close();
    state.running.value = false;
    deps.refreshKeys();
    refreshRuns();
    if (status === 'cancelled') toast(t('runs.cancelled'));
    else if (status === 'error') toast.error(t('runs.failed'));
    else toast.success(t('runs.finished'));
  }

  async function startRun() {
    if (!state.selInputs.value.length) return toast(t('runs.pickInput'));
    if (!state.selModels.value.length) return toast(t('runs.pickModel'));
    if (!state.selPrompts.value.length && !(state.customOn.value && state.custom.value.trim()))
      return toast(t('runs.pickPrompt'));

    const body: RunRequest = {
      inputs: { ids: [...state.selInputs.value] },
      models: { ids: [...state.selModels.value] },
      prompts: {
        presets: [...state.selPrompts.value],
        custom: state.customOn.value ? state.custom.value.trim() || null : null,
      },
      variants: Math.max(1, state.variants.value || 1),
      maxImages: Math.max(1, state.maxImages.value || 8),
      mock: state.mock.value,
    };
    if (state.referenceOn.value && state.selReference.value.length) {
      body.reference = { images: [...state.selReference.value], note: state.refNote.value.trim() || null };
    }

    state.submitting.value = true;
    try {
      const { runId: id } = await api.startRun(body);
      state.running.value = true;
      state.runId.value = id;
      state.runTitle.value = id;
      state.runStatus.value = 'queued';
      state.queuePosition.value = null;
      state.total.value = 0;
      state.jobs.clear();
      subscribe(id);
      refreshRuns();
      toast(t('runs.queued'));
    } catch (e) {
      toast.error(t('runs.startFailed'), { description: errMessage(e) });
    } finally {
      state.submitting.value = false;
    }
  }

  async function cancelRun() {
    if (!state.runId.value) return;
    try {
      await api.cancelRun(state.runId.value);
    } catch (e) {
      toast.error(t('runs.cancelFailed'), { description: errMessage(e) });
    }
  }

  return { refreshRuns, deleteRuns, startRun, cancelRun, refreshCostEstimate, scheduleCostEstimate };
}
