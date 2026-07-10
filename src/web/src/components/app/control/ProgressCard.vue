<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { ImageIcon, SquareIcon } from '@lucide/vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import type { JobStatus } from '@/types';

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
      <div class="grid max-h-[320px] gap-1.5 overflow-auto">
        <div
          v-for="job in store.jobList"
          :key="job.id"
          class="grid grid-cols-[12px_1fr_auto] items-center gap-2.5 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs"
          :title="job.status === 'error' && job.error ? job.error : ''"
        >
          <span class="size-3 rounded-full" :class="dot(job.status)" />
          <span class="truncate text-muted-foreground">
            {{ job.inputId }} · <b class="text-foreground">{{ job.modelId }}</b> · {{ job.promptId
            }}{{ job.variant > 1 ? ' v' + job.variant : '' }}
          </span>
          <span class="tabular-nums text-muted-foreground/70">
            {{ jobCostLabel(job) ? '$' + jobCostLabel(job) + ' · ' : '' }}{{ job.status === 'ok' || job.status === 'error' ? (job.ms || 0) + 'ms' : '' }}
          </span>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
