import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { useStorage } from '@vueuse/core';
import { toast } from 'vue-sonner';
import { api, ApiError, eventsUrl } from '@/lib/api';
import { toggleIn } from '@/lib/array';
import { recordFirstStar } from '@/lib/starTally';
import { t } from '@/i18n';
import { useControlStore } from '@/stores/control';
import type { InputItem, Job, Manifest, RunDeleteResponse, RunEvent, RunRetryResponse, RunSummary } from '@/types';

export interface InputGroup {
  input: InputItem;
  jobs: Job[];
  okCount: number;
}

export type ViewerHeight = 'aspect' | 'auto' | number;

export const useViewerStore = defineStore('viewer', () => {
  const runId = ref<string | null>(null);
  const manifest = ref<Manifest | null>(null);
  const runs = ref<RunSummary[]>([]);
  const deletingRunIds = ref<Set<string>>(new Set());
  const hiddenModels = ref<string[]>([]);
  const hiddenPrompts = ref<string[]>([]);
  // Per-item decisions ("I starred this output", "I hid this one") are keyed by `runId:jobId`
  // and PERSIST across refresh/reopen — losing them on reload is exactly the surprise the owner
  // hit (2026-07-21). Stale keys (a deleted run, a re-generated job) are pruned per run by
  // reconcileItemState when that run's manifest loads, so the stores don't grow without bound.
  // (The model/prompt filters above stay session-only: they're transient view filters, not a
  // record of a choice about a specific artifact.)
  const hiddenItems = useStorage<string[]>('redesign.viewer.hidden-items', []);
  const starredItems = useStorage<string[]>('redesign.viewer.starred-items', []);
  const showHiddenItems = ref(false);
  const showErrors = ref(false);

  // viewport controls
  const cols = ref(3);
  const zoom = ref(1280);
  const aspect = ref(0.72);
  const height = ref<ViewerHeight>('aspect');
  const previewScale = ref(1);

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let liveSource: EventSource | null = null;
  let liveJobIndexes = new Map<string, number>();
  let runsRequestSeq = 0;
  let loadRequestSeq = 0;
  const confirmedDeletedRunIds = new Set<string>();

  const isLive = computed(
    () => !!manifest.value && (manifest.value.status === 'queued' || manifest.value.status === 'running'),
  );
  // These checks run for every rendered output card. Keep reactive indexes rather than
  // rescanning the persisted arrays twice per card on every viewer update.
  const hiddenItemSet = computed(() => new Set(hiddenItems.value));
  const starredItemSet = computed(() => new Set(starredItems.value));

  function itemKey(id: string, activeRunId = runId.value) {
    return activeRunId ? `${activeRunId}:${id}` : id;
  }

  const grouped = computed<InputGroup[]>(() => {
    const m = manifest.value;
    if (!m) return [];
    const hiddenModelSet = new Set(hiddenModels.value);
    const hiddenPromptSet = new Set(hiddenPrompts.value);
    const hiddenItemKeys = hiddenItemSet.value;
    const starredItemKeys = starredItemSet.value;
    const jobsByInput = new Map<string, Job[]>();

    // Index the manifest once. The old input→filter(all jobs) shape was O(inputs × jobs)
    // and made large matrix runs (inputs × models × prompts × variants) needlessly expensive.
    for (const job of m.jobs || []) {
      const key = itemKey(job.id, m.runId);
      // 'skipped' jobs (no API keys configured, all keys cooling down) carry a real,
      // actionable message in job.error — surface them alongside errors, gated behind the
      // same showErrors preference, rather than silently dropping them like a pending job.
      if (
        hiddenModelSet.has(job.modelId) ||
        hiddenPromptSet.has(job.promptId) ||
        (!showHiddenItems.value && hiddenItemKeys.has(key)) ||
        (job.status !== 'ok' && !((job.status === 'error' || job.status === 'skipped') && showErrors.value))
      ) {
        continue;
      }
      const jobs = jobsByInput.get(job.inputId);
      if (jobs) jobs.push(job);
      else jobsByInput.set(job.inputId, [job]);
    }

    const out: InputGroup[] = [];
    for (const input of m.inputs || []) {
      const jobs = jobsByInput.get(input.id);
      if (!jobs?.length) continue;
      jobs.sort(
        (a, b) =>
          Number(starredItemKeys.has(itemKey(b.id, m.runId))) -
          Number(starredItemKeys.has(itemKey(a.id, m.runId))),
      );
      if (jobs.length) out.push({ input, jobs, okCount: jobs.filter((j) => j.status === 'ok').length });
    }
    return out;
  });

  function reconcileItemState(m: Manifest | null) {
    if (!m) return;
    const currentRunPrefix = `${m.runId}:`;
    const jobKeys = new Set((m.jobs || []).map((j) => itemKey(j.id, m.runId)));
    hiddenItems.value = hiddenItems.value.filter((id) => !id.startsWith(currentRunPrefix) || jobKeys.has(id));
    starredItems.value = starredItems.value.filter((id) => !id.startsWith(currentRunPrefix) || jobKeys.has(id));
  }

  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (liveSource) {
      liveSource.close();
      liveSource = null;
    }
  }

  function acceptManifest(next: Manifest | null) {
    manifest.value = next;
    liveJobIndexes = new Map((next?.jobs || []).map((job, index) => [job.id, index]));
    reconcileItemState(next);
    if (!isLive.value) stopPoll();
  }

  function handleLiveEvent(id: string, raw: string) {
    if (!raw || runId.value !== id) return;
    let event: RunEvent;
    try {
      event = JSON.parse(raw) as RunEvent;
    } catch {
      return;
    }
    if (event.runId !== id) return;
    if (event.type === 'start' || event.type === 'snapshot' || event.type === 'done') {
      acceptManifest(event.manifest);
      return;
    }
    if (event.type === 'error') {
      if (event.manifest) acceptManifest(event.manifest);
      else stopPoll();
      return;
    }
    const current = manifest.value;
    if (!current || current.runId !== id) return;
    const jobs = current.jobs || [];
    const index = liveJobIndexes.get(event.job.id);
    if (index !== undefined && jobs[index]?.id === event.job.id) {
      // Vue tracks the nested assignment, so there is no need to clone the entire manifest
      // and jobs array for every SSE event (which made a live N-job run O(N²)).
      jobs[index] = event.job;
    } else {
      liveJobIndexes.set(event.job.id, jobs.length);
      jobs.push(event.job);
    }
    current.status = 'running';
  }

  function startLiveUpdates(id: string) {
    if (!isLive.value) return;
    // The run queue already exposes an exact SSE stream. Prefer it so a live viewer gets
    // immediate job updates without re-reading and serializing the whole manifest every 2.5s.
    if (typeof EventSource !== 'undefined') {
      try {
        liveSource = new EventSource(eventsUrl(id));
        liveSource.onmessage = (event: MessageEvent<string>) => handleLiveEvent(id, event.data);
        return;
      } catch {
        liveSource = null;
      }
    }
    // Non-browser/test environments without EventSource retain the old resilient fallback.
    pollTimer = setInterval(refreshManifest, 2500);
  }

  async function loadRuns() {
    const seq = ++runsRequestSeq;
    try {
      const loaded = await api.runs();
      if (seq !== runsRequestSeq) return;
      const pending = deletingRunIds.value;
      runs.value = loaded.filter(
        (run) => !pending.has(run.runId) && !confirmedDeletedRunIds.has(run.runId),
      );
    } catch {
      // Keep the last good gallery snapshot through a transient refresh failure.
      // The initial value is already empty, so first-load failure still degrades cleanly.
    }
  }

  function pruneDeletedRunState(ids: string[]) {
    const prefixes = ids.map((id) => `${id}:`);
    const belongsToDeletedRun = (key: string) => prefixes.some((prefix) => key.startsWith(prefix));
    hiddenItems.value = hiddenItems.value.filter((key) => !belongsToDeletedRun(key));
    starredItems.value = starredItems.value.filter((key) => !belongsToDeletedRun(key));
  }

  async function deleteRuns(ids: string[]): Promise<RunDeleteResponse | null> {
    const uniqueIds = Array.from(
      new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)),
    ).filter((id) => !deletingRunIds.value.has(id));
    if (!uniqueIds.length) return null;

    ++runsRequestSeq;
    const snapshot = runs.value;
    const deleting = new Set(uniqueIds);
    const removed = snapshot.filter((run) => deleting.has(run.runId));
    deletingRunIds.value = new Set([...deletingRunIds.value, ...uniqueIds]);
    // Remove immediately after the user confirms. The authoritative response below
    // restores anything the server refused (notably a queued/running run).
    runs.value = snapshot.filter((run) => !deleting.has(run.runId));

    try {
      const result = await api.deleteRuns(uniqueIds);
      for (const id of result.deleted) confirmedDeletedRunIds.add(id);
      const otherPending = new Set(
        [...deletingRunIds.value].filter((id) => !deleting.has(id)),
      );
      const baselineIds = new Set(snapshot.map((run) => run.runId));
      const concurrentNewRuns = runs.value.filter((run) => !baselineIds.has(run.runId));
      const authoritative = (
        result.runs || snapshot.filter((run) => !result.deleted.includes(run.runId))
      ).filter(
        (run) =>
          !otherPending.has(run.runId) && !confirmedDeletedRunIds.has(run.runId),
      );
      runs.value = mergeRuns(authoritative, concurrentNewRuns);
      pruneDeletedRunState(result.deleted);
      useControlStore().forgetDeletedRuns(result.deleted);
      if (result.deleted.length) {
        toast.success(t('runs.pendingDelete', { count: result.deleted.length }, result.deleted.length));
      }
      if (result.skipped.length) {
        const first = result.skipped[0];
        const reason = first?.reason || t('runs.deleteFallbackReason');
        const message =
          result.skipped.length === 1
            ? t('runs.deleteOneFailed', {
                run: first?.runId || t('runs.runFallback'),
                reason,
              })
            : t(
                'runs.skippedMany',
                { count: result.skipped.length, reason },
                result.skipped.length,
              );
        if (result.deleted.length) toast(message);
        else toast.error(message);
      }
      return result;
    } catch (error) {
      runs.value = mergeRuns(runs.value, removed, snapshot);
      toast.error(t('runs.deleteFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      ++runsRequestSeq;
      const finished = new Set(uniqueIds);
      deletingRunIds.value = new Set(
        [...deletingRunIds.value].filter((id) => !finished.has(id)),
      );
    }
  }

  function mergeRuns(
    current: RunSummary[],
    restored: RunSummary[],
    preferredOrder?: RunSummary[],
  ): RunSummary[] {
    const byId = new Map(current.map((run) => [run.runId, run]));
    for (const run of restored) if (!byId.has(run.runId)) byId.set(run.runId, run);
    if (!preferredOrder) return [...byId.values()];
    const ordered: RunSummary[] = [];
    for (const run of preferredOrder) {
      const value = byId.get(run.runId);
      if (!value) continue;
      ordered.push(value);
      byId.delete(run.runId);
    }
    return [...ordered, ...byId.values()];
  }

  async function load(id: string | null) {
    // A slow response for a run the user has since navigated away from must not resolve last
    // and clobber whatever load() (or refreshManifest()) started after it — that would silently
    // overwrite a newer manifest and, since acceptManifest() calls stopPoll() once a manifest
    // looks finished, could kill the live SSE stream of the run the user actually selected.
    // Mirrors the runsRequestSeq pattern in loadRuns() below: only the latest request wins.
    const seq = ++loadRequestSeq;
    stopPoll();
    runId.value = id;
    if (!id) {
      acceptManifest(null);
      return;
    }
    let next: Manifest | null;
    try {
      next = await api.run(id);
    } catch {
      if (seq !== loadRequestSeq) return;
      acceptManifest(null);
      return;
    }
    if (seq !== loadRequestSeq) return;
    acceptManifest(next);
    startLiveUpdates(id);
  }

  async function refreshManifest() {
    if (!runId.value) return;
    const seq = ++loadRequestSeq;
    try {
      const next = await api.run(runId.value);
      if (seq !== loadRequestSeq) return;
      acceptManifest(next);
    } catch {
      /* transient; keep polling */
    }
  }

  /**
   * Re-run failed/skipped/cancelled jobs from the currently loaded run. `jobIds` narrows to a
   * single card's retry (ErrorCard's per-job button); omitted retries every non-ok job (the
   * run-level "Retry failed" action, ViewSettings.vue). Returns the server's `{ runIds, jobCount }`
   * so the caller can navigate to the new run, or null on failure (a toast already explained why).
   */
  async function retryJobs(jobIds?: string[]): Promise<RunRetryResponse | null> {
    if (!runId.value) return null;
    try {
      const result = await api.retryRun(runId.value, jobIds ? { jobIds } : {});
      toast.success(t('runs.retryStarted', { count: result.jobCount }, result.jobCount));
      return result;
    } catch (e) {
      // A 409 (this run is still going) carries a message worth showing verbatim rather than
      // a generic one, per the retry route's contract (src/http/routes/runs.ts).
      if (e instanceof ApiError && e.status === 409) toast.error(e.message);
      else toast.error(t('runs.retryFailed'), { description: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  function toggleModel(id: string) {
    hiddenModels.value = toggleIn(hiddenModels.value, id);
  }
  function togglePrompt(id: string) {
    hiddenPrompts.value = toggleIn(hiddenPrompts.value, id);
  }
  function isItemHidden(id: string) {
    return hiddenItemSet.value.has(itemKey(id));
  }
  function isItemStarred(id: string) {
    return starredItemSet.value.has(itemKey(id));
  }
  function toggleItemHidden(id: string) {
    hiddenItems.value = toggleIn(hiddenItems.value, itemKey(id));
  }
  function toggleItemStarred(id: string) {
    const key = itemKey(id);
    const starring = !starredItemSet.value.has(key);
    starredItems.value = toggleIn(starredItems.value, key);
    if (!starring || !runId.value) return;
    // Cross-run tally: only the FIRST star in a run counts, check before this
    // toggle added `key`, i.e. no other starred item already carries this run's prefix.
    const runPrefix = `${runId.value}:`;
    const isFirstInRun = starredItems.value.filter((i) => i.startsWith(runPrefix)).length === 1;
    if (!isFirstInRun) return;
    const job = manifest.value?.jobs.find((j) => j.id === id);
    const model = manifest.value?.models.find((m) => m.id === job?.modelId);
    if (model) recordFirstStar(runId.value, model.label || model.id);
  }

  return {
    runId,
    manifest,
    runs,
    deletingRunIds,
    hiddenModels,
    hiddenPrompts,
    hiddenItems,
    starredItems,
    showHiddenItems,
    showErrors,
    cols,
    zoom,
    aspect,
    height,
    previewScale,
    isLive,
    grouped,
    loadRuns,
    deleteRuns,
    load,
    refreshManifest,
    retryJobs,
    stopPoll,
    toggleModel,
    togglePrompt,
    isItemHidden,
    isItemStarred,
    toggleItemHidden,
    toggleItemStarred,
  };
});
