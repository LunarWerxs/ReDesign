<script setup lang="ts">
import { computed } from 'vue';
import { PlayIcon, SquareIcon, Loader2Icon } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';

const store = useControlStore();

// Pre-run "≈ $X" estimate, always clearly marked as an estimate, never shown as
// if it were the actual cost. See src/runner/cost.ts estimateRunCost() for the math
// (per-model average usage from recent runs, or a documented default fallback).
const estimateText = computed(() => {
  const est = store.costEstimate;
  if (!est || !store.estimate.count) return null;
  const amount = est.totalCost < 0.01 && est.totalCost > 0 ? est.totalCost.toFixed(4) : est.totalCost.toFixed(2);
  return est.anyFromDefault
    ? t('cost.estimateValueTilde', { amount })
    : t('cost.estimateValue', { amount });
});
const estimateTitle = computed(() => {
  const est = store.costEstimate;
  if (!est) return '';
  const bits: string[] = [];
  bits.push(est.anyFromDefault ? t('cost.estimateFromDefault') : t('cost.estimateFromHistory'));
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
      :disabled="store.submitting || store.running"
      :title="t('runControls.startRun')"
      @click="store.startRun()"
    >
      <Loader2Icon v-if="store.submitting" class="size-4 animate-spin" />
      <PlayIcon v-else class="size-4" />
      {{ store.submitting ? t('runControls.queueing') : t('runControls.run') }}
    </Button>
  </div>
</template>
