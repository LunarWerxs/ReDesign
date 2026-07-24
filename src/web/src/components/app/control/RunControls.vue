<script setup lang="ts">
import { computed } from 'vue';
import { ChevronDownIcon, PlayIcon, SquareIcon, Loader2Icon, ListPlusIcon } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
// The run button has two shapes, chosen by whether a queue is already LIVE:
//   • idle → a split button: primary "Run" (submit this batch AND start it, releasing any
//     parked batches too), with a ▾ menu offering "Add to queue" (park it) and, when some
//     are parked, "Run queue (N)" (run just the parked ones without re-adding this batch).
//   • a queue is running → a single "Add to queue" that tacks this batch onto the live queue
//     (autoStart), since "run now" makes no sense while something is already generating.
// Splitting run-vs-queue this way keeps a mis-click from launching a 900-job fan-out while
// still making "just run it" one obvious press.
const heldCount = computed(() => store.heldRuns.length);
const queueLabel = computed(() => (store.submitting ? t('runControls.queueing') : t('runControls.addToQueue')));
const busy = computed(() => store.submitting || store.startingQueue);

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

    <!-- A queue is already live → the only sensible action is to add behind it. -->
    <Button
      v-if="store.queueRunning"
      variant="secondary"
      :disabled="store.submitting"
      :title="t('runControls.addToLiveQueueHint')"
      @click="store.addToQueue(true)"
    >
      <Loader2Icon v-if="store.submitting" class="size-4 animate-spin" />
      <ListPlusIcon v-else class="size-4" />
      {{ queueLabel }}
    </Button>

    <!-- Idle → split Run button: primary runs now, the ▾ menu parks or runs the parked queue. -->
    <div v-else class="flex items-stretch">
      <!-- Label is ALWAYS "Run": the click runs the current batch PLUS anything parked, so a
           "Run queue (N)" label here would misrepresent it as running only the parked ones —
           that lives in the ▾ menu below (runQueue), which never adds the current selection. -->
      <Button
        class="rounded-r-none"
        :disabled="busy"
        :title="heldCount ? t('runControls.runNowWithQueueHint', { count: heldCount }) : t('runControls.runNowHint')"
        @click="store.runNow()"
      >
        <Loader2Icon v-if="busy" class="size-4 animate-spin" />
        <PlayIcon v-else class="size-4" />
        {{ t('runControls.run') }}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            class="rounded-l-none border-l border-l-primary-foreground/25 px-2"
            :disabled="busy"
            :aria-label="t('runControls.moreRunOptions')"
            :title="t('runControls.moreRunOptions')"
          >
            <ChevronDownIcon class="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="min-w-52">
          <DropdownMenuItem @click="store.addToQueue()">
            <ListPlusIcon class="size-4" />
            <span class="flex flex-col">
              <span>{{ t('runControls.addToQueue') }}</span>
              <span class="text-[11px] text-muted-foreground">{{ t('runControls.addToQueueHint') }}</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem v-if="heldCount" @click="store.runQueue()">
            <PlayIcon class="size-4" />
            <span class="flex flex-col">
              <span>{{ t('runControls.runQueueWithCount', { count: heldCount }) }}</span>
              <span class="text-[11px] text-muted-foreground">{{ t('runControls.runQueueOnlyHint') }}</span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>
