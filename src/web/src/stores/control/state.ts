import { useStorage } from '@vueuse/core';
import { computed, reactive, ref } from 'vue';
import { ApiError } from '@/lib/api';
import type {
  BrandAttachment,
  EstimateRunCost,
  InputItem,
  Job,
  KeySnapshot,
  Model,
  Prompt,
  ProviderDefault,
  ReferenceItem,
  RunSummary,
  SpendToDate,
} from '@/types';

const TERMINAL = new Set(['ok', 'error', 'skipped', 'cancelled']);

/** A run the client is watching: the one in flight plus anything queued behind it. */
export interface TrackedRun {
  runId: string;
  title: string;
  status: string;
  queuePosition: number | null;
  /** Parked in the queue: it has a position but won't start until "Run queue" is pressed. */
  queueHeld: boolean;
  total: number;
  jobs: Map<string, Job>;
  /** Client-side submit order, so the queue strip lists runs the way they were queued. */
  seq: number;
}

/** A run that is still ours to watch/cancel — anything the server hasn't finished. */
export function isActiveStatus(status?: string | null): boolean {
  return status === 'queued' || status === 'running';
}

export function isRunnable(m: Model): boolean {
  return !!(m && m.enabled && Number(m.keys) > 0);
}

export function errMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function createControlState() {
  // ---- bootstrap data ----
  const inputs = ref<InputItem[]>([]);
  const models = ref<Model[]>([]);
  const archivedModels = ref<Model[]>([]);
  const prompts = ref<Prompt[]>([]);
  const references = ref<ReferenceItem[]>([]);
  const keys = ref<KeySnapshot | null>(null);
  const runs = ref<RunSummary[]>([]);
  const deletingRunIds = ref<Set<string>>(new Set());
  const sessionInputIds = ref<string[]>([]);
  const spend = ref<SpendToDate | null>(null);
  const costEstimate = ref<EstimateRunCost | null>(null);
  const costEstimateLoading = ref(false);
  const providerDefaults = ref<Record<string, ProviderDefault>>({});

  // ---- selection / options ----
  // Everything the user *chose* persists per-browser (reconciled against the live
  // catalog on every bootstrap, see app-lifecycle.ts) so a refresh or a restart
  // doesn't hand back a picker they have to re-tick from scratch.
  // Two deliberate exceptions:
  //   • selInputs — screenshots stay on disk, so a remembered tick would silently
  //     re-run yesterday's input alongside today's and bill for it. Pick each run.
  //   • mock — a sticky mock flag means a "real" run quietly produces nothing.
  const selInputs = ref<string[]>([]);
  const selModels = useStorage<string[]>('redesign.sel-models', []);
  const selPrompts = useStorage<string[]>('redesign.sel-prompts', []);
  const selReference = useStorage<string[]>('redesign.sel-reference', []);
  const referenceOn = useStorage('redesign.reference-on', false);
  // True once bootstrap has seeded a first-ever model selection, so "nothing ticked"
  // reads as a deliberate choice on later loads instead of re-seeding every model.
  const selectionSeeded = useStorage('redesign.selection-seeded', false);
  const mock = ref(false);
  // Per-model copy count keyed by model id. Absence means the default of 1, so the
  // map only ever holds entries > 1 (see setModelQty). Replaces the old single
  // global "variants" number: each selected model can be generated N times.
  const modelQty = useStorage<Record<string, number>>('redesign.model-qty', {});
  const maxImages = useStorage('redesign.max-images', 8);
  const customOn = useStorage('redesign.custom-on', false);
  const custom = useStorage('redesign.custom-prompt', '');
  const advancedOpen = useStorage('redesign.advanced-open', false);
  const refNote = ref('');
  // Brand style guide: a durable brand brief appended to every generation prompt.
  // Persisted per-browser (unlike the one-off refNote); a brand outlives a single run.
  const brandOn = useStorage('redesign.brand-style-guide-on', false);
  const brandStyleGuide = useStorage('redesign.brand-style-guide', '');
  // A saved "default" style guide, separate from the field above so a user can
  // temporarily edit/override the guide for one run without losing their default.
  const brandStyleGuideDefault = useStorage('redesign.brand-style-guide-default', '');
  // File attachments for the brand style guide: text is read client-side and
  // inlined into the prompt at run time (see runs.ts startRun()). Session-only;
  // unlike the guide text itself, attachments are heavier and not meant to persist
  // silently across browser restarts.
  const brandAttachments = ref<BrandAttachment[]>([]);
  // Auto-inject the saved default the first time this browser has a default but an
  // empty working guide (e.g. first load, or after the guide was cleared elsewhere).
  if (!brandStyleGuide.value.trim() && brandStyleGuideDefault.value.trim()) {
    brandStyleGuide.value = brandStyleGuideDefault.value;
  }

  // ---- run progress ----
  // The server has always run a FIFO queue of runs (src/http/runQueue.ts): a second
  // POST while one is in flight is accepted and streams `queued` + a position until
  // it reaches the front. The client therefore tracks a *set* of runs, not one, and
  // holds a live SSE subscription per entry (see ./runs.ts). `focusedRunId` is the
  // one the progress card is showing; the rest are the queue behind it.
  const trackedRuns = reactive(new Map<string, TrackedRun>());
  const focusedRunId = useStorage<string | null>('redesign.focused-run', null);
  const submitting = ref(false); // POST /api/run in flight (Add to queue disabled, no Cancel yet)
  const startingQueue = ref(false); // POST /api/queue/start in flight (Run queue disabled)
  let trackSeq = 0;

  /** Register (or return) a tracked run. Never clobbers an entry we're already streaming. */
  function trackRun(id: string, init: Partial<TrackedRun> = {}): TrackedRun {
    const existing = trackedRuns.get(id);
    if (existing) {
      Object.assign(existing, init, { runId: id, jobs: existing.jobs, seq: existing.seq });
      return existing;
    }
    const entry: TrackedRun = {
      runId: id,
      title: init.title || id,
      status: init.status || 'queued',
      queuePosition: init.queuePosition ?? null,
      queueHeld: init.queueHeld ?? false,
      total: init.total ?? 0,
      jobs: new Map<string, Job>(),
      seq: ++trackSeq,
    };
    trackedRuns.set(id, entry);
    return trackedRuns.get(id) as TrackedRun;
  }

  function untrackRun(id: string): void {
    trackedRuns.delete(id);
    if (focusedRunId.value === id) focusedRunId.value = null;
  }

  const focusedRun = computed<TrackedRun | null>(() =>
    focusedRunId.value ? trackedRuns.get(focusedRunId.value) || null : null,
  );

  // Back-compat views of the focused run, so every existing consumer
  // (ProgressCard, RunControls, ViewSettings) keeps reading the same names.
  const runId = computed(() => focusedRun.value?.runId ?? null);
  const runTitle = computed(() => focusedRun.value?.title ?? '');
  const runStatus = computed(() => focusedRun.value?.status ?? null);
  const queuePosition = computed(() => focusedRun.value?.queuePosition ?? null);
  const total = computed(() => focusedRun.value?.total ?? 0);
  const running = computed(() => isActiveStatus(focusedRun.value?.status)); // Cancel shown
  /**
   * Every tracked run still queued or generating, in the order the server will run
   * them: whatever is generating first, then the queue by its server-assigned
   * position. A just-submitted run has no position until its first snapshot lands,
   * so it sorts to the back — which is where the server put it.
   */
  const queueRank = (run: TrackedRun): number => {
    if (run.status === 'running') return -1;
    return run.queuePosition ?? Number.MAX_SAFE_INTEGER;
  };
  const activeRuns = computed(() =>
    [...trackedRuns.values()]
      .filter((r) => isActiveStatus(r.status))
      .sort((a, b) => queueRank(a) - queueRank(b) || a.seq - b.seq),
  );
  /** The queue *behind* whatever the progress card is showing. */
  const backlogRuns = computed(() => activeRuns.value.filter((r) => r.runId !== focusedRunId.value));
  const anyRunActive = computed(() => activeRuns.value.length > 0);
  /**
   * Runs parked by "Add to queue" and waiting for a "Run queue" press. Drives that
   * button's enabled state and its count, so it can't be pressed on an empty queue.
   */
  const heldRuns = computed(() => activeRuns.value.filter((r) => r.status === 'queued' && r.queueHeld));

  // ---- live check (two-step confirm) ----
  const liveCheckArmed = ref(false);
  const liveCheckBusy = ref(false);

  // ---- getters ----
  const runnableModels = computed(() => models.value.filter(isRunnable));
  const runnableModelIds = computed(() => runnableModels.value.map((m) => m.id));
  const envNote = computed(() => `${models.value.length} models · ${inputs.value.length} inputs`);
  const jobList = computed(() => (focusedRun.value ? Array.from(focusedRun.value.jobs.values()) : []));

  const estimate = computed(() => {
    const nP = selPrompts.value.length + (customOn.value && custom.value.trim() ? 1 : 0);
    // Total "model runs" = sum of each selected model's quantity (default 1).
    const modelRuns = selModels.value.reduce((sum, id) => sum + Math.max(1, modelQty.value[id] || 1), 0);
    const count = selInputs.value.length * modelRuns * nP;
    const text = count
      ? `${count} job${count > 1 ? 's' : ''} (${selInputs.value.length} inputs × ${modelRuns} model runs × ${nP || 1} prompts)`
      : 'select inputs, models & a prompt';
    return { count, text };
  });

  const progress = computed(() => {
    let done = 0,
      ok = 0,
      error = 0,
      skipped = 0;
    const jobs = focusedRun.value?.jobs;
    if (jobs) {
      for (const j of jobs.values()) {
        if (TERMINAL.has(j.status)) done++;
        if (j.status === 'ok') ok++;
        else if (j.status === 'error') error++;
        else if (j.status === 'skipped' || j.status === 'cancelled') skipped++;
      }
    }
    const t = total.value || jobs?.size || 0;
    const pct = t ? Math.round((done / t) * 100) : 0;
    return { done, ok, error, skipped, total: t, pct };
  });

  return {
    // bootstrap data
    inputs,
    models,
    archivedModels,
    prompts,
    references,
    keys,
    runs,
    deletingRunIds,
    sessionInputIds,
    spend,
    costEstimate,
    costEstimateLoading,
    providerDefaults,
    // selection / options
    selInputs,
    selModels,
    selPrompts,
    selReference,
    referenceOn,
    selectionSeeded,
    mock,
    modelQty,
    maxImages,
    customOn,
    custom,
    advancedOpen,
    refNote,
    brandOn,
    brandStyleGuide,
    brandStyleGuideDefault,
    brandAttachments,
    // run progress
    trackedRuns,
    focusedRunId,
    focusedRun,
    trackRun,
    untrackRun,
    activeRuns,
    backlogRuns,
    anyRunActive,
    heldRuns,
    runId,
    runTitle,
    runStatus,
    queuePosition,
    total,
    running,
    submitting,
    startingQueue,
    // live check
    liveCheckArmed,
    liveCheckBusy,
    // getters
    runnableModels,
    runnableModelIds,
    envNote,
    jobList,
    estimate,
    progress,
  };
}

export type ControlState = ReturnType<typeof createControlState>;
