<script setup lang="ts">
// Viewer display/layout/filter controls, lifted out of the old ViewerOptionsMenu
// popover so they can live as sections inside the combined Settings sidebar.
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ChevronDownIcon } from '@lucide/vue';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import RunFlyout from '@/components/app/RunFlyout.vue';
import FilterSelect from '@/components/app/viewer/FilterSelect.vue';
import { useViewerStore } from '@/stores/viewer';
import { useControlStore } from '@/stores/control';
import { starTallyReadout } from '@/lib/starTally';
import { t } from '@/i18n';
import type { RunDeleteResponse } from '@/types';

const props = withDefaults(defineProps<{ surface?: 'dashboard' | 'viewer' }>(), {
  surface: 'viewer',
});

const store = useViewerStore();
const controlStore = useControlStore();
const router = useRouter();

const runsFlyoutOpen = ref(false);
const runsFlyoutMode = ref<'switch' | 'recent'>('switch');
const selectOpenKey = ref<ChoiceKey | null>(null);
const customInputs = ref<Record<string, string>>({});

const zoomOptions = [
  { v: '1440', label: t('viewSettings.desktop') },
  { v: '1280', label: t('viewSettings.laptop') },
  { v: '834', label: t('viewSettings.tablet') },
  { v: '414', label: t('viewSettings.phone') },
];
const aspectOptions = [
  { v: '0.72', label: t('viewSettings.portrait') },
  { v: '1', label: t('viewSettings.square') },
  { v: '1.5', label: t('viewSettings.landscape') },
];
const heightOptions = [
  { v: 'aspect', label: t('viewSettings.aspect') },
  { v: 'auto', label: t('viewSettings.auto') },
  { v: '844', label: '844' },
  { v: '1200', label: '1200' },
  { v: '1600', label: '1600' },
  { v: '2400', label: '2400' },
  { v: '3200', label: '3200' },
];
const previewScaleOptions = [
  { v: '1', label: '1x' },
  { v: '0.75', label: '0.75x' },
  { v: '0.5', label: '0.5x' },
  { v: '0.33', label: '0.33x' },
  { v: '0.25', label: '0.25x' },
];
const colOptions = [1, 2, 3, 4, 5].map((n) => ({ v: String(n), label: String(n) }));

type ChoiceKey = 'cols' | 'size' | 'zoom' | 'aspect' | 'height';

interface ChoiceRow {
  key: ChoiceKey;
  label: string;
  title: string;
  get: () => string;
  set: (v: string) => void;
  options: { v: string; label: string }[];
  format?: (v: string) => string;
  custom?: {
    min: string;
    max?: string;
    step: string;
    placeholder: string;
    suffix?: string;
    normalize: (v: string) => string | null;
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
function formatDecimal(value: number) {
  return Number.parseFloat(value.toFixed(2)).toString();
}
function normalizeColumns(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return String(clamp(Math.round(n), 1, 12));
}
function normalizePreviewScale(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return formatDecimal(clamp(n, 0.1, 4));
}
function formatPreviewScale(value: string) {
  const n = Number(value);
  return Number.isFinite(n) ? `${formatDecimal(n)}x` : value;
}

const displayRows = computed<ChoiceRow[]>(() => [
  {
    key: 'cols',
    label: t('viewSettings.columns'),
    title: t('viewSettings.columnsTitle'),
    get: () => String(store.cols),
    set: (v) => (store.cols = Number(v)),
    options: colOptions,
    custom: { min: '1', max: '12', step: '1', placeholder: String(store.cols), normalize: normalizeColumns },
  },
  {
    key: 'size',
    label: t('viewSettings.size'),
    title: t('viewSettings.sizeTitle'),
    get: () => String(store.zoom),
    set: (v) => (store.zoom = Number(v)),
    options: zoomOptions,
  },
  {
    key: 'zoom',
    label: t('viewSettings.zoom'),
    title: t('viewSettings.zoomTitle'),
    get: () => String(store.previewScale),
    set: (v) => (store.previewScale = Number(v)),
    options: previewScaleOptions,
    format: formatPreviewScale,
    custom: {
      min: '0.1',
      max: '4',
      step: '0.05',
      placeholder: formatDecimal(store.previewScale),
      suffix: 'x',
      normalize: normalizePreviewScale,
    },
  },
]);

const layoutRows = computed<ChoiceRow[]>(() => [
  {
    key: 'aspect',
    label: t('viewSettings.aspectLabel'),
    title: t('viewSettings.aspectTitle'),
    get: () => String(store.aspect),
    set: (v) => (store.aspect = Number(v)),
    options: aspectOptions,
  },
  {
    key: 'height',
    label: t('viewSettings.height'),
    title: t('viewSettings.heightTitle'),
    get: () => String(store.height),
    set: (v) => (store.height = v === 'aspect' || v === 'auto' ? v : Number(v)),
    options: heightOptions,
  },
]);

const currentTask = computed(() => {
  const m = store.manifest;
  if (m?.summary?.title) return m.summary.title;
  const r = store.runs.find((x) => x.runId === store.runId);
  return r?.title || r?.summary?.title || store.runId || t('viewSettings.noRunSelected');
});
const errorCount = computed(() => store.manifest?.counts?.error || 0);
const flyoutTitle = computed(() => (runsFlyoutMode.value === 'switch' ? t('viewSettings.switchRun') : t('viewSettings.recentRuns')));
const flyoutDescription = computed(() =>
  runsFlyoutMode.value === 'switch'
    ? t('viewSettings.switchRunDescription')
    : t('viewSettings.recentRunsDescription'),
);
const flyoutActionLabel = computed(() => (runsFlyoutMode.value === 'switch' ? t('viewSettings.switch') : t('viewSettings.view')));
const flyoutRuns = computed(() =>
  runsFlyoutMode.value === 'switch' || props.surface === 'viewer' ? store.runs : controlStore.runs,
);
const flyoutCurrentRunId = computed(() => store.runId || controlStore.runId || null);

function openRunPicker() {
  runsFlyoutMode.value = 'switch';
  void store.loadRuns();
  setTimeout(() => {
    runsFlyoutOpen.value = true;
  }, 0);
}
function selectRun(id: string) {
  runsFlyoutOpen.value = false;
  if (id === store.runId && props.surface === 'viewer') return;
  const target = { path: '/viewer', query: { run: id } };
  if (props.surface === 'viewer') router.replace(target);
  else router.push(target);
  store.load(id);
}
const errorsValue = computed(() => {
  if (!errorCount.value) return t('viewSettings.noneActive');
  return store.showErrors ? t('viewSettings.errorsShown', { count: errorCount.value }) : t('viewSettings.errorsHidden', { count: errorCount.value });
});

async function deleteRuns(ids: string[]): Promise<RunDeleteResponse | null> {
  const result = await controlStore.deleteRuns(ids);
  if (!result) return null;
  store.runs = result.runs;
  if (store.runId && result.deleted.includes(store.runId)) {
    const nextRunId = result.runs[0]?.runId || null;
    if (props.surface === 'viewer') {
      if (nextRunId) router.replace({ path: '/viewer', query: { run: nextRunId } });
      else router.replace({ path: '/viewer' });
    }
    store.load(nextRunId);
  }
  return result;
}

const rowTriggerClass =
  'w-full h-auto data-[size=default]:h-auto justify-between gap-3 rounded-none border-0 bg-transparent dark:bg-transparent px-3.5 py-[7px] text-[13px] font-normal text-popover-foreground shadow-none ring-0 outline-none transition-colors hover:bg-accent dark:hover:bg-accent focus-visible:bg-accent focus-visible:ring-0 [&>svg]:hidden';

function choiceValue(row: ChoiceRow) {
  const value = row.get();
  const match = row.options.find((o) => o.v === value);
  return match?.label || row.format?.(value) || value;
}
function syncCustomInput(row: ChoiceRow) {
  if (!row.custom) return;
  customInputs.value[row.key] = '';
}
function setChoice(row: ChoiceRow, value: string) {
  row.set(value);
  syncCustomInput(row);
  selectOpenKey.value = null;
}
function setSelectOpen(row: ChoiceRow, isOpen: boolean) {
  if (isOpen) syncCustomInput(row);
  selectOpenKey.value = isOpen ? row.key : null;
}
function applyCustomChoice(row: ChoiceRow) {
  const next = row.custom?.normalize(customInputs.value[row.key] || '');
  if (!next) return;
  row.set(next);
  syncCustomInput(row);
  selectOpenKey.value = null;
}
function selectCustomInput(event: FocusEvent) {
  if (event.target instanceof HTMLInputElement) event.target.select();
}
</script>

<template>
  <div class="divide-y divide-border">
    <!-- Project -->
    <section class="py-1">
      <p class="px-3.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {{ t('viewSettings.project') }}
      </p>
      <button
        type="button"
        class="flex w-full items-center justify-between gap-3 px-3.5 py-[7px] text-left outline-none transition-colors hover:bg-accent"
        :title="t('viewSettings.switchRunTitle')"
        @click="openRunPicker"
      >
        <span class="shrink-0 text-[13px] text-muted-foreground">{{ t('viewSettings.currentTask') }}</span>
        <span class="flex min-w-0 flex-1 items-center justify-end gap-1 text-[13px] font-medium text-foreground">
          <span class="truncate" :title="currentTask">{{ currentTask }}</span>
          <ChevronDownIcon class="size-3 shrink-0 text-muted-foreground/60" />
        </span>
      </button>
    </section>

    <!-- Display -->
    <section class="py-1">
      <p class="px-3.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {{ t('viewSettings.display') }}
      </p>
      <Select
        v-for="row in displayRows"
        :key="row.key"
        :model-value="row.get()"
        :open="selectOpenKey === row.key"
        @update:open="(isOpen) => setSelectOpen(row, isOpen)"
        @update:model-value="(v) => setChoice(row, String(v))"
      >
        <SelectTrigger :class="rowTriggerClass" :title="row.title">
          <span class="text-[13px] text-muted-foreground">{{ row.label }}</span>
          <span class="flex items-center gap-1 text-[13px] font-medium text-foreground">
            <span>{{ choiceValue(row) }}</span>
            <ChevronDownIcon class="size-3 text-muted-foreground/60" />
          </span>
        </SelectTrigger>
        <SelectContent position="popper" align="end" :side-offset="4">
          <SelectItem v-for="o in row.options" :key="o.v" :value="o.v">{{ o.label }}</SelectItem>
          <div v-if="row.custom" class="mt-1 border-t px-2 py-2" @click.stop @pointerdown.stop>
            <form class="flex items-center gap-1.5" @submit.prevent="applyCustomChoice(row)">
              <Input
                v-model="customInputs[row.key]"
                type="number"
                :min="row.custom.min"
                :max="row.custom.max"
                :step="row.custom.step"
                :placeholder="row.custom.placeholder"
                class="h-7 text-[12px]"
                @focus="selectCustomInput"
                @keydown.stop
              />
              <span v-if="row.custom.suffix" class="shrink-0 text-[12px] text-muted-foreground">
                {{ row.custom.suffix }}
              </span>
              <Button type="button" variant="ghost" size="xs" class="shrink-0" @click.stop.prevent="applyCustomChoice(row)">
                {{ t('viewSettings.set') }}
              </Button>
            </form>
          </div>
        </SelectContent>
      </Select>
    </section>

    <!-- Layout -->
    <section class="py-1">
      <p class="px-3.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {{ t('viewSettings.layout') }}
      </p>
      <Select
        v-for="row in layoutRows"
        :key="row.key"
        :model-value="row.get()"
        :open="selectOpenKey === row.key"
        @update:open="(isOpen) => setSelectOpen(row, isOpen)"
        @update:model-value="(v) => setChoice(row, String(v))"
      >
        <SelectTrigger :class="rowTriggerClass" :title="row.title">
          <span class="text-[13px] text-muted-foreground">{{ row.label }}</span>
          <span class="flex items-center gap-1 text-[13px] font-medium text-foreground">
            <span>{{ choiceValue(row) }}</span>
            <ChevronDownIcon class="size-3 text-muted-foreground/60" />
          </span>
        </SelectTrigger>
        <SelectContent position="popper" align="end" :side-offset="4">
          <SelectItem v-for="o in row.options" :key="o.v" :value="o.v">{{ o.label }}</SelectItem>
        </SelectContent>
      </Select>
    </section>

    <!-- Filters -->
    <section class="py-1">
      <p class="px-3.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {{ t('viewSettings.filters') }}
      </p>
      <FilterSelect kind="models" variant="row" />
      <FilterSelect kind="prompts" variant="row" />
      <div
        class="flex cursor-pointer items-center justify-between px-3.5 py-[7px] transition-colors hover:bg-accent"
        :title="t('viewSettings.showHiddenTitle')"
        @click="store.showHiddenItems = !store.showHiddenItems"
      >
        <span class="text-[13px] text-muted-foreground">{{ t('viewSettings.showHidden') }}</span>
        <Switch :model-value="store.showHiddenItems" size="sm" class="pointer-events-none" />
      </div>
    </section>

    <!-- Status -->
    <section class="py-1">
      <p class="px-3.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {{ t('viewSettings.status') }}
      </p>
      <div
        class="flex cursor-pointer items-center justify-between px-3.5 py-[7px] transition-colors hover:bg-accent"
        :title="t('viewSettings.showErrorsTitle')"
        @click="store.showErrors = !store.showErrors"
      >
        <span class="text-[13px] text-muted-foreground">{{ t('viewSettings.errors') }}</span>
        <span class="text-[13px] font-medium" :class="errorCount ? 'text-destructive' : 'text-muted-foreground'">
          {{ errorsValue }}
        </span>
      </div>
      <p v-if="starTallyReadout" class="px-3.5 pb-2 pt-1 text-[11.5px] text-muted-foreground/70">
        {{ starTallyReadout }}
      </p>
    </section>
  </div>

  <RunFlyout
    v-model:open="runsFlyoutOpen"
    :title="flyoutTitle"
    :description="flyoutDescription"
    :runs="flyoutRuns"
    :current-run-id="flyoutCurrentRunId"
    :deleting-run-ids="controlStore.deletingRunIds"
    :action-label="flyoutActionLabel"
    :delete-runs="deleteRuns"
    @select-run="selectRun"
  />
</template>
