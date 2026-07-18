<script setup lang="ts">
import { computed } from 'vue';
import { PlayIcon, SquareIcon, Loader2Icon, ListPlusIcon } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';

const store = useControlStore();

// Pre-run "≈ $X" estimate, always clearly marked as an estimate, never shown as
// if it were the actual cost. See src/runner/cost.ts estimateRunCost() for the math
// (per-model average usage from recent runs, or a documented default fallback).
const fmtAmount = (v: number) => (v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2));

// Show a low-high band alongside the point estimate when recent runs of these
// models varied enough that a single number would be misleading (a dense
// screenshot emits far more HTML than a simple one). Threshold keeps tight
// spreads from adding noise.
const showRange = computed(() => {
  const est = store.costEstimate;
  if (!est || est.anyFromDefault) return false;
  const low = est.totalCostLow ?? est.totalCost;
  const high = est.totalCostHigh ?? est.totalCost;
  return low > 0 && high > low * 1.25;
});
const estimateText = computed(() => {
  const est = store.costEstimate;
  if (!est || !store.estimate.count) return null;
  const amount = fmtAmount(est.totalCost);
  if (showRange.value) {
    return t('cost.estimateWithRange', {
      amount,
      low: fmtAmount(est.totalCostLow),
      high: fmtAmount(est.totalCostHigh),
    });
  }
  return est.anyFromDefault
    ? t('cost.estimateValueTilde', { amount })
    : t('cost.estimateValue', { amount });
});
// The server runs a FIFO queue of runs, so Run stays live while one is generating:
// pressing it again stacks another batch behind the current one rather than being
// refused. The label says which of the two is about to happen.
const runLabel = computed(() => {
  if (store.submitting) return t('runControls.queueing');
  if (!store.anyRunActive) return t('runControls.run');
  return t('runControls.queueAnother', { count: store.activeRuns.length }, store.activeRuns.length);
});

const estimateTitle = computed(() => {
  const est = store.costEstimate;
  if (!est) return '';
  const bits: string[] = [];
  bits.push(est.anyFromDefault ? t('cost.estimateFromDefault') : t('cost.estimateFromHistory'));
  if (showRange.value) bits.push(t('cost.estimateRangeNote'));
  if (est.anyEstimatePricing) bits.push(t('cost.estimatePricingIsGuess'));
  return bits.join(' · ');
});
</script>

<template>
  <div class="flex w-full flex-wrap items-center justify-end gap-x-3 gap-y-2">
    <span
      v-if="estimateText"
      class="text-xs text-muted-foreground"
      :title="estimateTitle"
    >
      {{ t('cost.estimateLabel') }}: {{ estimateText }}
    </span>
    <Button v-if="store.running" variant="destructive" :title="t('runControls.stopRun')" @click="store.cancelRun()">
      <SquareIcon class="size-4" /> {{ t('runControls.cancel') }}
    </Button>
    <Button
      :disabled="store.submitting"
      :title="store.anyRunActive ? t('runControls.queueRun') : t('runControls.startRun')"
      @click="store.startRun()"
    >
      <Loader2Icon v-if="store.submitting" class="size-4 animate-spin" />
      <ListPlusIcon v-else-if="store.anyRunActive" class="size-4" />
      <PlayIcon v-else class="size-4" />
      {{ runLabel }}
    </Button>
  </div>
</template>
