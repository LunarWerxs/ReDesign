<script setup lang="ts">
// AI observability: the by-model rollup for GET /api/costs/traces (see src/runner/cost.ts
// recentTraces()). The Run Cost Meter next to this section only ever shows a total; this is
// the per-generation view PostHog's ai_observability product has and RēDesign didn't - which
// model is slow, which one errors, broken out instead of folded into one dollar figure.
import { onMounted, ref } from 'vue';
import { api } from '@/lib/api';
import { t } from '@/i18n';
import type { ModelTraceStats } from '@/types';

const byModel = ref<ModelTraceStats[]>([]);
const loaded = ref(false);

function formatMs(ms: number | null): string {
  if (ms == null) return '-';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatCost(cost: number): string {
  return cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2);
}

onMounted(async () => {
  try {
    const result = await api.costsTraces();
    byModel.value = Object.values(result.byModel).sort((a, b) => b.totalCost - a.totalCost);
  } catch (_) {
    // Best-effort: an empty section (loaded stays true, byModel stays []) reads the same as
    // "nothing yet", which is an acceptable failure mode for a secondary stats panel.
  } finally {
    loaded.value = true;
  }
});
</script>

<template>
  <div v-if="loaded && byModel.length" class="mt-3 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
    <div class="mb-1.5 font-medium text-muted-foreground">{{ t('cost.tracesToggle') }}</div>
    <div v-for="stats in byModel" :key="stats.modelId" class="flex items-center justify-between gap-2 py-0.5">
      <span class="truncate font-mono">{{ stats.modelId }}</span>
      <span class="flex shrink-0 items-center gap-2 text-muted-foreground">
        <span>{{ t('cost.tracesCalls', { count: stats.calls }) }}</span>
        <span v-if="stats.errors" class="text-destructive">{{ t('cost.tracesErrors', { count: stats.errors }) }}</span>
        <span>{{ t('cost.tracesAvgLatency', { ms: formatMs(stats.avgLatencyMs) }) }}</span>
        <span class="font-mono font-semibold text-foreground">${{ formatCost(stats.totalCost) }}</span>
      </span>
    </div>
  </div>
  <p v-else-if="loaded" class="mt-3 text-[11px] text-muted-foreground/70">{{ t('cost.tracesEmpty') }}</p>
</template>
