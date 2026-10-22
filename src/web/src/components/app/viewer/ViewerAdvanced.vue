<script setup lang="ts">
// The viewer settings people rarely touch, behind the toolbar's Advanced button. Everything used
// while looking through a run (run, filters, columns, size, one at a time, downloads, retry) is on
// the toolbar itself (ViewerToolbar.vue), one click away.
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ChevronDownIcon, RotateCcwIcon } from '@lucide/vue';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ArenaLeaderboard from '@/components/app/viewer/ArenaLeaderboard.vue';
import { useViewerStore } from '@/stores/viewer';
import { useControlStore } from '@/stores/control';
import { starTallyReadout } from '@/lib/starTally';
import { t } from '@/i18n';

const store = useViewerStore();
const controlStore = useControlStore();
const router = useRouter();

const selectOpenKey = ref<ChoiceKey | null>(null);
const customInputs = ref<Record<string, string>>({});

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

type ChoiceKey = 'zoom' | 'aspect' | 'height';

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

function formatDecimal(value: number) {
  return Number.parseFloat(value.toFixed(2)).toString();
}
function normalizePreviewScale(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return formatDecimal(Math.min(4, Math.max(0.1, n)));
}
function formatPreviewScale(value: string) {
  const n = Number(value);
  return Number.isFinite(n) ? `${formatDecimal(n)}x` : value;
}

const choiceRows = computed<ChoiceRow[]>(() => [
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

const errorCount = computed(() => store.manifest?.counts?.error || 0);
const errorsValue = computed(() => {
  if (!errorCount.value) return t('viewSettings.noneActive');
  return store.showErrors ? t('viewSettings.errorsShown', { count: errorCount.value }) : t('viewSettings.errorsHidden', { count: errorCount.value });
});

const canRepeatOriginal = computed(() => store.manifest?.specVersion === 1);
const repeatingOriginal = ref(false);
async function repeatOriginal() {
  if (repeatingOriginal.value) return;
  repeatingOriginal.value = true;
  try {
    const nextRunId = await store.repeatOriginal();
    // Exact repeats are deliberately held. Moving to the control page makes the pending queue
    // visible and gives the owner the existing Run queue button to release it. Control may
    // already be initialized, so register it before navigation instead of relying on bootstrap.
    if (nextRunId) {
      await controlStore.adoptHeldRun(nextRunId);
      await router.push('/');
    }
  } finally {
    repeatingOriginal.value = false;
  }
}

// The row triggers are full-width, so the popper would inherit that width via
// --reka-select-trigger-width and balloon; size the option list to its own content instead.
const selectContentClass =
  '[&_[data-position=popper]]:w-auto! [&_[data-position=popper]]:min-w-0!';

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
    <section class="py-1">
      <p class="px-3.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {{ t('viewSettings.previews') }}
      </p>
      <Select
        v-for="row in choiceRows"
        :key="row.key"
        :model-value="row.get()"
        :open="selectOpenKey === row.key"
        @update:open="(isOpen) => setSelectOpen(row, isOpen)"
        @update:model-value="(v) => setChoice(row, String(v))"
      >
        <SelectTrigger variant="row" :title="row.title">
          <span class="text-ui text-muted-foreground">{{ row.label }}</span>
          <span class="flex items-center gap-1 text-ui font-medium text-foreground">
            <span>{{ choiceValue(row) }}</span>
            <ChevronDownIcon class="size-3 text-muted-foreground/60" />
          </span>
        </SelectTrigger>
        <SelectContent position="popper" align="end" :side-offset="4" :class="selectContentClass">
          <SelectItem v-for="o in row.options" :key="o.v" :value="o.v">{{ o.label }}</SelectItem>
          <div v-if="row.custom" class="mt-1 border-t p-2" @click.stop @pointerdown.stop>
            <form class="flex items-center gap-1.5" @submit.prevent="applyCustomChoice(row)">
              <Input
                v-model="customInputs[row.key]"
                type="number"
                :min="row.custom.min"
                :max="row.custom.max"
                :step="row.custom.step"
                :placeholder="row.custom.placeholder"
                @focus="selectCustomInput"
                @keydown.stop
              />
              <span v-if="row.custom.suffix" class="shrink-0 text-xs text-muted-foreground">
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

    <section class="py-1">
      <p class="px-3.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {{ t('viewSettings.showing') }}
      </p>
      <div
        class="flex cursor-pointer items-center justify-between px-3.5 py-1.75 transition-colors hover:bg-accent"
        :title="t('viewSettings.showHiddenTitle')"
        @click="store.showHiddenItems = !store.showHiddenItems"
      >
        <span class="text-ui text-muted-foreground">{{ t('viewSettings.showHidden') }}</span>
        <Switch :model-value="store.showHiddenItems" size="sm" class="pointer-events-none" />
      </div>
      <div
        class="flex cursor-pointer items-center justify-between px-3.5 py-1.75 transition-colors hover:bg-accent"
        :title="t('viewSettings.showErrorsTitle')"
        @click="store.showErrors = !store.showErrors"
      >
        <span class="text-ui text-muted-foreground">{{ t('viewSettings.errors') }}</span>
        <span class="text-ui font-medium" :class="errorCount ? 'text-destructive' : 'text-muted-foreground'">
          {{ errorsValue }}
        </span>
      </div>
    </section>

    <section class="py-1">
      <p class="px-3.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {{ t('viewSettings.thisRun') }}
      </p>
      <div
        class="flex cursor-pointer items-center justify-between px-3.5 py-1.75 transition-colors hover:bg-accent"
        :title="t('viewSettings.keepRunTitle')"
        @click="store.setReviewKeep(!store.review.keep)"
      >
        <span class="text-ui text-muted-foreground">{{ t('viewer.keepRun') }}</span>
        <Switch :model-value="store.review.keep" size="sm" class="pointer-events-none" />
      </div>
      <button
        v-if="canRepeatOriginal"
        type="button"
        class="flex w-full items-center justify-between gap-3 px-3.5 py-1.75 text-start outline-none transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
        :disabled="store.isLive || repeatingOriginal"
        :title="store.isLive ? t('viewer.repeatOriginalWaitTitle') : t('viewer.repeatOriginalTitle')"
        @click="repeatOriginal"
      >
        <span class="text-ui text-muted-foreground">{{ t('viewer.repeatOriginal') }}</span>
        <RotateCcwIcon class="size-3.5 shrink-0 text-muted-foreground/60" :class="repeatingOriginal ? 'animate-spin' : ''" />
      </button>
      <p v-if="starTallyReadout" class="px-3.5 pb-2 pt-1 text-xs text-muted-foreground/70">
        {{ starTallyReadout }}
      </p>
      <ArenaLeaderboard />
    </section>
  </div>
</template>
