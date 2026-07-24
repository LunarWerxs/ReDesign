import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { useStorage } from '@vueuse/core';
import { api, eventsUrl } from '@/lib/api';
import { toggleIn } from '@/lib/array';
import { recordFirstStar } from '@/lib/starTally';
import type { InputItem, Job, Manifest, RunEvent, RunSummary } from '@/types';

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
      if (
        hiddenModelSet.has(job.modelId) ||
        hiddenPromptSet.has(job.promptId) ||
        (!showHiddenItems.value && hiddenItemKeys.has(key)) ||
        (job.status !== 'ok' && !(job.status === 'error' && showErrors.value))
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
    try {
      runs.value = await api.runs();
    } catch {
      runs.value = [];
    }
  }

  async function load(id: string | null) {
    stopPoll();
    runId.value = id;
    if (!id) {
      acceptManifest(null);
      return;
    }
    try {
      acceptManifest(await api.run(id));
    } catch {
      acceptManifest(null);
      return;
    }
    startLiveUpdates(id);
  }

  async function refreshManifest() {
    if (!runId.value) return;
    try {
      acceptManifest(await api.run(runId.value));
    } catch {
      /* transient; keep polling */
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
    load,
    refreshManifest,
    stopPoll,
    toggleModel,
    togglePrompt,
    isItemHidden,
    isItemStarred,
    toggleItemHidden,
    toggleItemStarred,
  };
});
