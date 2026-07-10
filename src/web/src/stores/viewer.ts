import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { api } from '@/lib/api';
import { toggleIn } from '@/lib/array';
import { recordFirstStar } from '@/lib/starTally';
import type { InputItem, Job, Manifest, RunSummary } from '@/types';

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
  const hiddenItems = ref<string[]>([]);
  const starredItems = ref<string[]>([]);
  const showHiddenItems = ref(false);
  const showErrors = ref(false);

  // viewport controls
  const cols = ref(3);
  const zoom = ref(1280);
  const aspect = ref(0.72);
  const height = ref<ViewerHeight>('aspect');
  const previewScale = ref(1);

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const isLive = computed(
    () => !!manifest.value && (manifest.value.status === 'queued' || manifest.value.status === 'running'),
  );

  function itemKey(id: string, activeRunId = runId.value) {
    return activeRunId ? `${activeRunId}:${id}` : id;
  }

  const grouped = computed<InputGroup[]>(() => {
    const m = manifest.value;
    if (!m) return [];
    const out: InputGroup[] = [];
    for (const input of m.inputs || []) {
      const jobs = (m.jobs || [])
        .filter(
          (j) =>
            j.inputId === input.id &&
            !hiddenModels.value.includes(j.modelId) &&
            !hiddenPrompts.value.includes(j.promptId) &&
            (showHiddenItems.value || !hiddenItems.value.includes(itemKey(j.id, m.runId))) &&
            (j.status === 'ok' || (j.status === 'error' && showErrors.value)),
        )
        .sort(
          (a, b) =>
            Number(starredItems.value.includes(itemKey(b.id, m.runId))) -
            Number(starredItems.value.includes(itemKey(a.id, m.runId))),
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
      manifest.value = null;
      return;
    }
    try {
      manifest.value = await api.run(id);
      reconcileItemState(manifest.value);
    } catch {
      manifest.value = null;
      return;
    }
    if (isLive.value) pollTimer = setInterval(refreshManifest, 2500);
  }

  async function refreshManifest() {
    if (!runId.value) return;
    try {
      manifest.value = await api.run(runId.value);
      reconcileItemState(manifest.value);
      if (!isLive.value) stopPoll();
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
    return hiddenItems.value.includes(itemKey(id));
  }
  function isItemStarred(id: string) {
    return starredItems.value.includes(itemKey(id));
  }
  function toggleItemHidden(id: string) {
    hiddenItems.value = toggleIn(hiddenItems.value, itemKey(id));
  }
  function toggleItemStarred(id: string) {
    const key = itemKey(id);
    const starring = !starredItems.value.includes(key);
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
