<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useVirtualList } from '@vueuse/core';
import { dragAndDrop } from '@formkit/drag-and-drop/vue';
import { animations, tearDown } from '@formkit/drag-and-drop';
import { GripVerticalIcon, ImageIcon, SquareIcon, XIcon } from '@lucide/vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import type { Job, JobStatus } from '@/types';
import type { TrackedRun } from '@/stores/control/state';

const store = useControlStore();

const dotClass: Record<string, string> = {
  ok: 'bg-success',
  error: 'bg-destructive',
  running: 'bg-warning animate-pulse',
  skipped: 'bg-muted-foreground',
  cancelled: 'bg-muted-foreground',
};
function dot(status: JobStatus) {
  return dotClass[status] || 'bg-muted-foreground/50';
}

// The whole pipeline, one chip per batch, so "what's lined up" is a list of items rather than a
// lone "position 1 · up next". Shown once there's more than one batch, or a single batch that
// hasn't started generating yet (a just-parked queue). The RUNNING batch (if any) is a static
// chip — its controls live in the card header — while the QUEUED batches below it are drag-
// reorderable and each carries a ✕ to drop it.
const showQueue = computed(
  () => store.activeRuns.length > 1 || (store.activeRuns.length === 1 && store.runStatus === 'queued'),
);
const runningRun = computed(() => store.activeRuns.find((r) => r.status === 'running') || null);
const queuedRuns = computed(() => store.activeRuns.filter((r) => r.status === 'queued'));

function runDot(status?: string) {
  if (status === 'running') return 'bg-warning animate-pulse';
  if (status === 'error') return 'bg-destructive';
  return 'bg-muted-foreground/60';
}
function runState(run: { status?: string; queueHeld?: boolean; queuePosition?: number | null }) {
  if (run.status === 'running') return t('progress.generating');
  if (run.queueHeld) return t('progress.parked');
  return run.queuePosition ? t('progress.position', { n: run.queuePosition }) : t('progress.waiting');
}

// Drag-to-reorder the queued batches (same @formkit setup as the model list). The bound list is a
// local copy synced from `queuedRuns` except while a drag is in flight, so an incoming SSE
// snapshot can't yank a chip out from under the pointer; on drop we persist the new order to the
// server (store.reorderQueue), which renumbers positions and re-broadcasts.
const queueParent = ref<HTMLElement>();
const queueList = ref<TrackedRun[]>([]);
const queueDragging = ref(false);
const canReorderQueue = computed(() => queuedRuns.value.length > 1);
function syncQueueList() {
  if (!queueDragging.value) queueList.value = [...queuedRuns.value];
}
watch(queuedRuns, syncQueueList, { immediate: true });
dragAndDrop({
  parent: queueParent,
  values: queueList,
  dragHandle: '.queue-drag',
  draggingClass: 'opacity-70',
  nativeDrag: false,
  longPress: true,
  longPressDuration: 200,
  plugins: [animations()],
  onDragstart: () => (queueDragging.value = true),
  onDragend: () => {
    const ids = queueList.value.map((r) => r.runId);
    queueDragging.value = false;
    void store.reorderQueue(ids);
    syncQueueList();
  },
});
onBeforeUnmount(() => queueParent.value && tearDown(queueParent.value));

// Running actual-spend total for this run, updated live as job results carry
// usage (see src/runner/cost.ts costForUsage(), accumulated per-job in
// src/runner/reimagine.ts). Blank until at least one job has priced usage.
const runningCostLabel = computed(() => {
  let total = 0;
  let any = false;
  for (const j of store.jobList) {
    if (j.cost) {
      total += j.cost.totalCost;
      any = true;
    }
  }
  if (!any) return null;
  const amount = total < 0.01 ? total.toFixed(4) : total.toFixed(2);
  return t('cost.actualCost', { amount });
});
function jobCostLabel(job: { cost?: { totalCost: number } | null }) {
  if (!job.cost || !job.cost.totalCost) return '';
  return job.cost.totalCost < 0.01 ? job.cost.totalCost.toFixed(4) : job.cost.totalCost.toFixed(2);
}

// The runner's per-job note explains the non-obvious cases (a text-only model fed
// an auto caption, an output truncated at the token limit) — worth surfacing, since
// those are exactly the rows a user asks "why was that one so slow/short?" about.
function jobTooltip(job: Job): string {
  if (job.status === 'error' && job.error) return job.error;
  return job.note || '';
}

// A fan-out is inputs × models × prompts × copies, so a run the UI itself can build
// reaches ~900 jobs — and every row used to sit in the DOM at once, which is enough
// to stall the renderer while the run is still streaming into it. Only the rows in
// view are mounted now.
//
// The pitch below MUST match the row's own geometry: a 30px row (h-[30px]) plus the
// 6px gap it carries as mb-1.5. The row height is explicit rather than derived from
// padding so a future content change can't silently desync the two.
const JOB_ROW_PITCH_PX = 36;
const {
  list: visibleJobs,
  containerProps: jobListContainer,
  wrapperProps: jobListWrapper,
} = useVirtualList(
  computed(() => store.jobList),
  { itemHeight: JOB_ROW_PITCH_PX, overscan: 8 },
);
</script>

<template>
  <Card v-if="store.runId">
    <CardHeader class="flex flex-row items-start gap-2.5 border-b">
      <CardTitle class="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {{ t('progress.runProgress') }}
        <span class="ml-1 inline-block max-w-full truncate align-bottom font-normal normal-case text-muted-foreground/70" :title="store.runId || ''">
          {{ store.runTitle }}
        </span>
      </CardTitle>
      <div class="flex shrink-0 items-center gap-1.5">
        <Button v-if="store.running" variant="destructive" size="sm" @click="store.cancelRun()">
          <SquareIcon class="size-3.5" /> {{ t('progress.cancel') }}
        </Button>
        <Button as-child variant="default" size="sm" :title="t('progress.viewThisRun')">
          <RouterLink :to="{ path: '/viewer', query: { run: store.runId } }">
            <ImageIcon class="size-3.5" /> {{ t('progress.viewer') }}
          </RouterLink>
        </Button>
      </div>
    </CardHeader>
    <CardContent>
      <Progress v-if="store.runStatus !== 'queued'" :model-value="store.progress.pct" class="mb-2.5" />
      <div class="mb-2.5 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <template v-if="store.runStatus === 'queued'">
          <span>{{ t('progress.queuedWaiting') }}</span>
        </template>
        <template v-else>
          <span>{{ t('progress.doneOfTotal', { done: store.progress.done, total: store.progress.total }) }}</span>
          <span class="text-success">{{ t('progress.okCount', { count: store.progress.ok }) }}</span>
          <span v-if="store.progress.error" class="text-destructive">{{ t('progress.errorCount', { count: store.progress.error }) }}</span>
          <span v-if="store.progress.skipped">{{ t('progress.skippedCount', { count: store.progress.skipped }) }}</span>
          <!-- i18n-ignore -->
          <span v-if="store.runStatus">{{ store.runStatus }}</span>
          <span v-if="runningCostLabel" class="ml-auto font-mono">{{ runningCostLabel }}</span>
        </template>
      </div>
      <!-- The whole pipeline as a list of batches: what's generating and everything queued
           behind it. The server queues submissions FIFO; this is what makes that queue visible
           and steerable — click a chip to watch it, × to drop it before it starts. -->
      <div v-if="showQueue" class="mb-2.5 grid gap-1.5">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('progress.queueLabel', { count: store.activeRuns.length }) }}
        </span>
        <div class="flex flex-wrap items-center gap-1.5 text-xs">
          <!-- running batch: static (its Cancel/View live in the card header) -->
          <span
            v-if="runningRun"
            class="flex items-center gap-1.5 rounded-full border py-0.5 pl-2 pr-2.5"
            :class="runningRun.runId === store.runId ? 'border-primary/50 bg-accent' : 'bg-muted/30'"
          >
            <span class="size-2 shrink-0 rounded-full" :class="runDot(runningRun.status)" />
            <button
              type="button"
              class="max-w-[180px] truncate text-muted-foreground hover:text-foreground"
              :title="t('progress.watchThisRun', { run: runningRun.runId })"
              @click="store.focusRun(runningRun.runId)"
            >
              {{ runningRun.title }}
              <span class="text-muted-foreground/70">· {{ runState(runningRun) }}</span>
            </button>
          </span>

          <!-- queued batches: drag-reorderable, each droppable via ✕ -->
          <div ref="queueParent" class="flex flex-wrap items-center gap-1.5">
            <span
              v-for="run in queueList"
              :key="run.runId"
              class="flex items-center gap-1 rounded-full border py-0.5 pl-1 pr-0.5"
              :class="run.runId === store.runId ? 'border-primary/50 bg-accent' : 'bg-muted/30'"
            >
              <button
                v-if="canReorderQueue"
                type="button"
                class="queue-drag flex size-4 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/40 outline-none transition-colors hover:text-muted-foreground active:cursor-grabbing"
                :aria-label="t('progress.dragToReorder')"
                :title="t('progress.dragToReorder')"
              >
                <GripVerticalIcon class="size-3" />
              </button>
              <span v-else class="size-2 shrink-0 rounded-full" :class="runDot(run.status)" />
              <button
                type="button"
                class="max-w-[180px] truncate text-muted-foreground hover:text-foreground"
                :title="t('progress.watchThisRun', { run: run.runId })"
                @click="store.focusRun(run.runId)"
              >
                {{ run.title }}
                <span class="text-muted-foreground/70">· {{ runState(run) }}</span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                class="size-5 rounded-full text-muted-foreground hover:text-destructive"
                :title="t('progress.cancelQueued')"
                @click="store.cancelRun(run.runId)"
              >
                <XIcon class="size-3" />
              </Button>
            </span>
          </div>
        </div>
      </div>
      <div v-bind="jobListContainer" class="max-h-[320px]">
        <div v-bind="jobListWrapper">
          <Tooltip v-for="{ data: job } in visibleJobs" :key="job.id" :disabled="!jobTooltip(job)">
            <TooltipTrigger as-child>
              <div
                class="mb-1.5 grid h-[30px] grid-cols-[12px_1fr_auto] items-center gap-2.5 rounded-md border bg-muted/30 px-2.5 text-xs"
              >
                <span class="size-3 rounded-full" :class="dot(job.status)" />
                <span class="truncate text-muted-foreground">
                  {{ job.inputId }} · <b class="text-foreground">{{ job.modelId }}</b> · {{ job.promptId
                  }}{{ job.variant > 1 ? ' v' + job.variant : '' }}
                </span>
                <span class="tabular-nums text-muted-foreground/70">
                  {{ jobCostLabel(job) ? '$' + jobCostLabel(job) + ' · ' : ''
                  }}{{ job.status === 'ok' || job.status === 'error' ? (job.ms || 0) + 'ms' : ''
                  }}<span v-if="job.prepMs && (job.status === 'ok' || job.status === 'error')" class="text-muted-foreground/50">
                    {{ t('progress.prepMs', { ms: job.prepMs }) }}
                  </span>
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent v-if="jobTooltip(job)" class="max-w-xs">{{ jobTooltip(job) }}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
