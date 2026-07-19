<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useVirtualList } from '@vueuse/core';
import { ImageIcon, SquareIcon, XIcon } from '@lucide/vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import type { Job, JobStatus } from '@/types';

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
      <Progress :model-value="store.progress.pct" class="mb-2.5" />
      <div class="mb-2.5 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <template v-if="store.runStatus === 'queued'">
          <span>{{ t('progress.queued') }}</span>
          <span>{{ store.queuePosition ? t('progress.position', { n: store.queuePosition }) : t('progress.waiting') }}</span>
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
      <!-- Runs stacked behind this one. The server has always queued a second
           submission FIFO; this strip is what makes that queue visible and
           steerable (click to watch, × to drop it before it starts). -->
      <div v-if="store.backlogRuns.length" class="mb-2.5 flex flex-wrap items-center gap-1.5 text-xs">
        <span class="text-muted-foreground">{{ t('progress.upNext') }}</span>
        <span
          v-for="queued in store.backlogRuns"
          :key="queued.runId"
          class="flex items-center gap-1 rounded-full border bg-muted/30 py-0.5 pl-2.5 pr-0.5"
        >
          <button
            type="button"
            class="max-w-[160px] truncate text-muted-foreground hover:text-foreground"
            :title="t('progress.watchThisRun', { run: queued.runId })"
            @click="store.focusRun(queued.runId)"
          >
            {{ queued.title }}
            <span v-if="queued.queuePosition" class="text-muted-foreground/70">
              · {{ t('progress.position', { n: queued.queuePosition }) }}
            </span>
          </button>
          <Button
            variant="ghost"
            size="icon"
            class="size-5 rounded-full text-muted-foreground hover:text-destructive"
            :title="t('progress.cancelQueued')"
            @click="store.cancelRun(queued.runId)"
          >
            <XIcon class="size-3" />
          </Button>
        </span>
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
