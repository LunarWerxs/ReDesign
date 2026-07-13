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
  const selInputs = ref<string[]>([]);
  const selModels = ref<string[]>([]);
  const selPrompts = ref<string[]>([]);
  const selReference = ref<string[]>([]);
  const referenceOn = ref(false);
  const mock = ref(false);
  // Per-model copy count keyed by model id. Absence means the default of 1, so the
  // map only ever holds entries > 1 (see setModelQty). Replaces the old single
  // global "variants" number: each selected model can be generated N times.
  const modelQty = ref<Record<string, number>>({});
  const maxImages = ref(8);
  const customOn = ref(false);
  const custom = ref('');
  const advancedOpen = ref(false);
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
  const runId = ref<string | null>(null);
  const runTitle = ref('');
  const runStatus = ref<string | null>(null);
  const queuePosition = ref<number | null>(null);
  const total = ref(0);
  const jobs = reactive(new Map<string, Job>());
  const running = ref(false); // a run exists and is streaming (Cancel shown)
  const submitting = ref(false); // POST /api/run in flight (Run disabled, no Cancel yet)

  // ---- live check (two-step confirm) ----
  const liveCheckArmed = ref(false);
  const liveCheckBusy = ref(false);

  // ---- getters ----
  const runnableModels = computed(() => models.value.filter(isRunnable));
  const runnableModelIds = computed(() => runnableModels.value.map((m) => m.id));
  const envNote = computed(() => `${models.value.length} models · ${inputs.value.length} inputs`);
  const jobList = computed(() => Array.from(jobs.values()));

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
    for (const j of jobs.values()) {
      if (TERMINAL.has(j.status)) done++;
      if (j.status === 'ok') ok++;
      else if (j.status === 'error') error++;
      else if (j.status === 'skipped' || j.status === 'cancelled') skipped++;
    }
    const t = total.value || jobs.size;
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
    runId,
    runTitle,
    runStatus,
    queuePosition,
    total,
    jobs,
    running,
    submitting,
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
