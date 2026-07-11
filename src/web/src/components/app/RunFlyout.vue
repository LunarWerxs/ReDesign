<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  CheckIcon,
  ImageIcon,
  Loader2Icon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from '@lucide/vue';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { RunDeleteResponse, RunSummary } from '@/types';
import { t } from '@/i18n';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description?: string;
    runs: RunSummary[];
    currentRunId?: string | null;
    deletingRunIds?: Set<string>;
    actionLabel?: string;
    deleteRuns?: (ids: string[]) => Promise<RunDeleteResponse | null>;
  }>(),
  {
    description: () => t('runFlyout.defaultDescription'),
    currentRunId: null,
    deletingRunIds: () => new Set<string>(),
    actionLabel: () => t('runFlyout.view'),
    deleteRuns: undefined,
  },
);

const emit = defineEmits<{
  (e: 'update:open', open: boolean): void;
  (e: 'select-run', runId: string): void;
}>();

const dialogOpen = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value),
});

const editMode = ref(false);
const selectedRunIds = ref<string[]>([]);

const canDelete = computed(() => !!props.deleteRuns);
const selectedCount = computed(() => selectedRunIds.value.length);
const selectedSet = computed(() => new Set(selectedRunIds.value));
const allSelected = computed(() => !!props.runs.length && selectedRunIds.value.length === props.runs.length);
const deleteConfirmDescription = computed(() =>
  t('runFlyout.deleteConfirmDescription', { count: selectedCount.value }, selectedCount.value),
);

function runTitle(run: RunSummary) {
  return run.title || run.summary?.title || run.runId;
}

function runTally(run: RunSummary) {
  if (run.status === 'queued') return t('runFlyout.queued');
  const ok = run.counts?.ok || 0;
  const error = run.counts?.error || 0;
  const total = run.total ?? run.counts?.total ?? 0;
  return error ? t('runFlyout.tallyWithErrors', { ok, total, error }, error) : `${ok}/${total}`;
}

// Actual (not estimated) spend for a finished run, from the manifest-computed
// totals in src/runner/cost.ts. Blank until at least one job has priced usage.
function runCostLabel(run: RunSummary) {
  const cost = run.cost;
  if (!cost || !cost.jobCount || !cost.totalCost) return null;
  const amount = cost.totalCost < 0.01 ? cost.totalCost.toFixed(4) : cost.totalCost.toFixed(2);
  return t('cost.actualCost', { amount });
}
function runCostTitle(run: RunSummary) {
  const cost = run.cost;
  if (!cost) return '';
  const bits: string[] = [];
  if (cost.anyEstimatePricing) bits.push(t('cost.estimatePricingIsGuess'));
  if (cost.anyUnpriced) bits.push(t('cost.unpriced'));
  return bits.join(' · ');
}

function isSelected(runId: string) {
  return selectedSet.value.has(runId);
}

function isDeleting(runId: string) {
  return props.deletingRunIds.has(runId);
}

function beginEdit() {
  editMode.value = true;
  selectedRunIds.value = [];
}

function cancelEdit() {
  editMode.value = false;
  selectedRunIds.value = [];
}

function toggleSelection(runId: string) {
  if (isDeleting(runId)) return;
  selectedRunIds.value = isSelected(runId)
    ? selectedRunIds.value.filter((id) => id !== runId)
    : [...selectedRunIds.value, runId];
}

function toggleAllSelection() {
  selectedRunIds.value = allSelected.value ? [] : props.runs.map((run) => run.runId);
}

const deleteConfirmOpen = ref(false);

function deleteSelected() {
  if (!props.deleteRuns || !selectedRunIds.value.length) return;
  deleteConfirmOpen.value = true;
}

async function confirmDeleteSelected() {
  if (!props.deleteRuns || !selectedRunIds.value.length) return;
  const result = await props.deleteRuns(selectedRunIds.value);
  if (!result) return;

  const skipped = new Set(result.skipped.map((run) => run.runId));
  selectedRunIds.value = selectedRunIds.value.filter((id) => skipped.has(id));
  if (!selectedRunIds.value.length) editMode.value = false;
}

function activateRun(runId: string) {
  if (editMode.value) {
    toggleSelection(runId);
    return;
  }
  emit('select-run', runId);
}

function onRowKeydown(e: KeyboardEvent, runId: string) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  activateRun(runId);
}

watch(
  () => props.runs.map((run) => run.runId),
  (ids) => {
    const valid = new Set(ids);
    selectedRunIds.value = selectedRunIds.value.filter((id) => valid.has(id));
    if (!ids.length) editMode.value = false;
  },
);

watch(
  () => props.open,
  (open) => {
    if (!open) cancelEdit();
  },
);
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="max-h-[min(86vh,760px)] gap-0 overflow-hidden p-0 sm:max-w-2xl">
      <DialogHeader class="border-b px-5 pb-4 pt-5 pr-14">
        <div class="flex min-w-0 items-start justify-between gap-3">
          <div class="min-w-0">
            <DialogTitle class="truncate">
              {{ title }}
              <span class="ml-1 font-normal text-muted-foreground">{{ runs.length }}</span>
            </DialogTitle>
            <DialogDescription>{{ description }}</DialogDescription>
          </div>

          <div v-if="runs.length && canDelete" class="flex shrink-0 items-center gap-1">
            <template v-if="editMode">
              <Button
                variant="ghost"
                size="xs"
                :title="allSelected ? t('runFlyout.clearSelection') : t('runFlyout.selectAllRuns')"
                @click="toggleAllSelection"
              >
                {{ allSelected ? t('runFlyout.none') : t('runFlyout.all') }}
              </Button>
              <Button variant="ghost" size="xs" :title="t('runFlyout.cancelEditing')" @click="cancelEdit">
                <XIcon class="size-3.5" />
                {{ t('runFlyout.cancel') }}
              </Button>
              <Button
                variant="destructive"
                size="xs"
                :title="t('runFlyout.deleteSelectedRuns')"
                :disabled="!selectedCount"
                @click="deleteSelected"
              >
                <Trash2Icon class="size-3.5" />
                {{ t('runFlyout.delete') }}
              </Button>
            </template>
            <Tooltip v-else>
              <TooltipTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  :aria-label="t('runFlyout.selectRunsToDelete')"
                  @click="beginEdit"
                >
                  <PencilIcon class="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{{ t('runFlyout.selectRunsToDelete') }}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <p v-if="editMode" class="pt-1 text-xs text-muted-foreground">
          {{ t('runFlyout.selectedCount', { count: selectedCount }, selectedCount) }}
        </p>
      </DialogHeader>

      <div class="grid max-h-[min(68vh,620px)] gap-2 overflow-y-auto px-5 py-4">
        <p v-if="!runs.length" class="px-3 py-8 text-center text-sm text-muted-foreground">{{ t('runFlyout.noRunsYet') }}</p>

        <div
          v-for="run in runs"
          :key="run.runId"
          class="group/run flex items-center gap-2.5 rounded-md border bg-muted/30 px-2.5 py-2 text-left transition-colors hover:border-muted-foreground/40 hover:bg-accent/60 focus-visible:border-primary focus-visible:outline-none"
          :class="[
            run.runId === currentRunId && !editMode ? 'border-primary/40 bg-accent' : '',
            isSelected(run.runId) ? 'border-primary bg-accent' : '',
            isDeleting(run.runId) ? 'pointer-events-none opacity-70' : 'cursor-pointer',
          ]"
          role="button"
          tabindex="0"
          :aria-pressed="editMode ? isSelected(run.runId) : run.runId === currentRunId"
          :title="runTitle(run) !== run.runId ? t('runFlyout.titleWithRunId', { title: runTitle(run), runId: run.runId }) : run.runId"
          @click="activateRun(run.runId)"
          @keydown="onRowKeydown($event, run.runId)"
        >
          <Checkbox
            v-if="editMode"
            :model-value="isSelected(run.runId)"
            :disabled="isDeleting(run.runId)"
            :aria-label="t('runFlyout.selectRunTitle', { title: runTitle(run) })"
            @click.stop
            @update:model-value="toggleSelection(run.runId)"
          />
          <CheckIcon
            v-else
            class="size-4 shrink-0"
            :class="run.runId === currentRunId ? 'text-primary' : 'text-transparent'"
          />

          <span class="grid min-w-0 gap-px">
            <span class="truncate text-xs font-bold">{{ runTitle(run) }}</span>
            <span class="truncate font-mono text-[11px] text-muted-foreground/70">{{ run.runId }}</span>
          </span>

          <span class="flex-1" />

          <Badge v-if="run.status && run.status !== 'done'" variant="secondary">{{ run.status }}</Badge>
          <span
            v-if="runCostLabel(run)"
            class="shrink-0 font-mono text-[11px] text-muted-foreground/70"
            :title="runCostTitle(run)"
          >
            {{ runCostLabel(run) }}
          </span>
          <span class="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Loader2Icon v-if="run.status === 'running' || run.status === 'queued'" class="size-3 animate-spin" />
            {{ runTally(run) }}
          </span>
          <span
            v-if="!editMode"
            class="hidden shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors group-hover/run:bg-background sm:inline-flex"
          >
            <ImageIcon class="size-3.5" />
            {{ run.runId === currentRunId ? t('runFlyout.current') : actionLabel }}
          </span>
        </div>
      </div>
    </DialogContent>
  </Dialog>

  <AlertDialog v-model:open="deleteConfirmOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ t('runFlyout.deleteSelectedRunsTitle') }}</AlertDialogTitle>
        <AlertDialogDescription>{{ deleteConfirmDescription }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ t('runFlyout.cancel') }}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" @click="confirmDeleteSelected">{{ t('runFlyout.delete') }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
