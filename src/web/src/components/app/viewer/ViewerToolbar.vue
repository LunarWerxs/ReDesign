<script setup lang="ts">
// The open run's controls, laid out across the top of the viewer instead of behind a menu: what
// you reach for while looking through a run is one click here, and the rarely touched rest sits
// under Advanced (ViewerAdvanced.vue). Sticks under the app bar so it stays in reach while you scroll.
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  ChevronDownIcon,
  DownloadIcon,
  LaptopIcon,
  Maximize2Icon,
  MonitorIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  TabletIcon,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import RunFlyout from '@/components/app/RunFlyout.vue';
import FilterSelect from './FilterSelect.vue';
import ViewerAdvanced from './ViewerAdvanced.vue';
import { useViewerStore } from '@/stores/viewer';
import { runDownloadUrl } from '@/lib/api';
import { t } from '@/i18n';
import type { RunDeleteResponse } from '@/types';

const store = useViewerStore();
const router = useRouter();

const sizes = [
  { v: '1440', label: t('viewSettings.desktop'), icon: MonitorIcon },
  { v: '1280', label: t('viewSettings.laptop'), icon: LaptopIcon },
  { v: '834', label: t('viewSettings.tablet'), icon: TabletIcon },
  { v: '414', label: t('viewSettings.phone'), icon: SmartphoneIcon },
];
const columnChoices = ['1', '2', '3', '4', '5'];

const runTitle = computed(() => {
  const m = store.manifest;
  if (m?.summary?.title) return m.summary.title;
  const r = store.runs.find((x) => x.runId === store.runId);
  return r?.title || r?.summary?.title || store.runId || t('viewSettings.noRunSelected');
});

// ── Run picker ───────────────────────────────────────────────────────────────
const runsOpen = ref(false);
function openRunPicker() {
  void store.loadRuns();
  setTimeout(() => {
    runsOpen.value = true;
  }, 0);
}
function selectRun(id: string) {
  runsOpen.value = false;
  if (id === store.runId) return;
  void router.replace({ path: '/viewer', query: { run: id } });
  store.load(id);
}
async function deleteRuns(ids: string[]): Promise<RunDeleteResponse | null> {
  const result = await store.deleteRuns(ids);
  if (!result) return null;
  if (store.runId && result.deleted.includes(store.runId)) {
    const nextRunId = result.runs[0]?.runId || null;
    void router.replace(nextRunId ? { path: '/viewer', query: { run: nextRunId } } : { path: '/viewer' });
    store.load(nextRunId);
  }
  return result;
}

// ── Run actions ──────────────────────────────────────────────────────────────
const retryableCount = computed(
  () => (store.manifest?.jobs || []).filter((j) => j.status === 'error' || j.status === 'skipped' || j.status === 'cancelled').length,
);
const hasOutputs = computed(() => (store.manifest?.counts?.ok ?? 0) > 0);
const downloadAllUrl = computed(() => (store.runId ? runDownloadUrl(store.runId) : ''));
const retrying = ref(false);
async function retryFailed() {
  if (retrying.value) return;
  retrying.value = true;
  try {
    const result = await store.retryJobs();
    const target = result?.runIds.length === 1 ? result.runIds[0] : null;
    if (target) void router.push({ path: '/viewer', query: { run: target } });
  } finally {
    retrying.value = false;
  }
}

function setColumns(v: unknown) {
  if (v) store.cols = Number(v);
}
function setSize(v: unknown) {
  if (v) store.zoom = Number(v);
}

// Keep Advanced open when the click that would dismiss it lands in a dialog or a toast it
// raised, so those coexist with it instead of racing it.
function keepAdvancedOpen(e: Event) {
  const target = (e as CustomEvent).detail?.originalEvent?.target as HTMLElement | null;
  if (target?.closest('[role="dialog"], [role="alertdialog"], [data-sonner-toaster]')) e.preventDefault();
}
</script>

<template>
  <div
    class="sticky top-14.5 z-30 flex flex-wrap items-center gap-2 border-b bg-background/90 px-4.5 py-2 backdrop-blur supports-backdrop-filter:bg-background/75"
    role="toolbar"
    :aria-label="t('viewSettings.toolbar')"
  >
    <Button variant="ghost" size="sm" class="min-w-0 max-w-72" :title="t('viewSettings.switchRunTitle')" @click="openRunPicker">
      <span class="truncate font-semibold">{{ runTitle }}</span>
      <ChevronDownIcon class="size-3.5 shrink-0 text-muted-foreground" />
    </Button>

    <FilterSelect kind="models" />
    <FilterSelect kind="prompts" />

    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      :model-value="String(store.cols)"
      :aria-label="t('viewSettings.columns')"
      :title="t('viewSettings.columnsTitle')"
      @update:model-value="setColumns"
    >
      <ToggleGroupItem
        v-for="n in columnChoices"
        :key="n"
        :value="n"
        data-segment="count"
        :aria-label="t('viewSettings.columnsCount', { count: n })"
      >
        {{ n }}
      </ToggleGroupItem>
    </ToggleGroup>

    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      :model-value="String(store.zoom)"
      :aria-label="t('viewSettings.size')"
      @update:model-value="setSize"
    >
      <ToggleGroupItem
        v-for="s in sizes"
        :key="s.v"
        :value="s.v"
        data-segment
        :aria-label="s.label"
        :title="t('viewSettings.sizeOption', { size: s.label, width: s.v })"
      >
        <component :is="s.icon" class="size-4" />
      </ToggleGroupItem>
    </ToggleGroup>

    <Button variant="outline" size="sm" :disabled="!store.focusList.length" :title="t('viewSettings.oneAtATimeTitle')" @click="store.openFocus()">
      <Maximize2Icon class="size-3.5" />
      {{ t('viewSettings.oneAtATime') }}
    </Button>

    <span class="flex-1" />

    <Button
      v-if="store.canArena && !store.arenaPair"
      variant="ghost"
      size="sm"
      :title="t('viewer.arenaStartTitle')"
      @click="store.nextArenaPair()"
    >
      {{ t('viewer.arenaStart') }}
    </Button>

    <Button
      v-if="retryableCount"
      variant="ghost"
      size="sm"
      data-retry-failed
      :disabled="store.isLive || retrying"
      :title="store.isLive ? t('viewSettings.retryFailedWaitTitle') : t('viewSettings.retryFailedTitle')"
      @click="retryFailed"
    >
      <RefreshCwIcon class="size-3.5" :class="retrying ? 'animate-spin' : ''" />
      {{ t('viewSettings.retryFailedCount', { count: retryableCount }) }}
    </Button>

    <DropdownMenu v-if="hasOutputs">
      <DropdownMenuTrigger as-child>
        <Button variant="ghost" size="sm" :title="t('viewSettings.downloadAllTitle')">
          <DownloadIcon class="size-3.5" />
          {{ t('viewSettings.download') }}
          <ChevronDownIcon class="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem as-child>
          <a :href="downloadAllUrl">{{ t('viewSettings.downloadAll') }}</a>
        </DropdownMenuItem>
        <DropdownMenuItem as-child>
          <a :href="`${downloadAllUrl}?shortlist=1`">{{ t('viewer.downloadShortlist') }}</a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <Popover>
      <PopoverTrigger as-child>
        <Button variant="ghost" size="sm" :title="t('viewSettings.advancedTitle')">
          <SlidersHorizontalIcon class="size-3.5" />
          {{ t('viewSettings.advanced') }}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        :collision-padding="12"
        flush
        class="max-h-[min(80vh,620px)] w-[min(320px,calc(100vw-2rem))] overflow-y-auto"
        @interact-outside="keepAdvancedOpen"
        @focus-outside="keepAdvancedOpen"
      >
        <ViewerAdvanced />
      </PopoverContent>
    </Popover>
  </div>

  <RunFlyout
    v-model:open="runsOpen"
    :title="t('viewSettings.switchRun')"
    :description="t('viewSettings.switchRunDescription')"
    :runs="store.runs"
    :current-run-id="store.runId"
    :deleting-run-ids="store.deletingRunIds"
    :action-label="t('viewSettings.switch')"
    :delete-runs="deleteRuns"
    @select-run="selectRun"
  />
</template>
