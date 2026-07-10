import { computed, reactive, ref } from 'vue';
import { ApiError } from '@/lib/api';
import type {
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
  const variants = ref(1);
  const maxImages = ref(8);
  const customOn = ref(false);
  const custom = ref('');
  const advancedOpen = ref(false);
  const refNote = ref('');

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
    const v = Math.max(1, variants.value || 1);
    const count = selInputs.value.length * selModels.value.length * nP * v;
    const text = count
      ? `${count} job${count > 1 ? 's' : ''} (${selInputs.value.length} inputs × ${selModels.value.length} models × ${nP || 1} prompts × ${v})`
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
    variants,
    maxImages,
    customOn,
    custom,
    advancedOpen,
    refNote,
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
