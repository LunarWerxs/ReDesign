<script setup lang="ts">
import { ExternalLinkIcon, DownloadIcon, EyeIcon, StarIcon, XIcon } from '@lucide/vue';
import { computed } from 'vue';
import { outputUrl, outputRawUrl, downloadUrl } from '@/lib/api';
import { Button } from '@/components/ui/button';
import type { Job } from '@/types';
import type { ViewerHeight } from '@/stores/viewer';
import ScaledFrame from './ScaledFrame.vue';
import { t } from '@/i18n';

const props = defineProps<{
  job: Job;
  modelLabel: string;
  modelColor: string;
  promptLabel: string;
  rw: number;
  ar: number;
  height: ViewerHeight;
  scale: number;
  starred: boolean;
  itemHidden: boolean;
}>();

defineEmits<{ (e: 'toggle-star'): void; (e: 'toggle-hidden'): void }>();

const rawUrl = computed(() => outputRawUrl(props.job.file || '', { measure: props.height === 'auto' }));

const sub = () => {
  let s = props.promptLabel;
  if (props.job.variant > 1) s += ` · v${props.job.variant}`;
  if (props.job.truncated) s += ` · ${t('viewer.truncatedWarning')}`;
  if (props.job.wrapped) s += ` · ${t('viewer.wrappedWarning')}`;
  if (props.job.cost && props.job.cost.totalCost > 0) {
    const amount = props.job.cost.totalCost < 0.01 ? props.job.cost.totalCost.toFixed(4) : props.job.cost.totalCost.toFixed(2);
    s += ` · ${t('cost.actualCost', { amount })}`;
  }
  return s;
};
</script>

<template>
  <div
    class="flex flex-col overflow-hidden rounded-lg border bg-card transition-opacity"
    :class="itemHidden ? 'opacity-50 grayscale' : ''"
  >
    <div class="flex min-w-0 items-center gap-2.5 border-b px-3 py-2.5">
      <span class="size-2.5 shrink-0 rounded-full" :style="{ background: modelColor || '#888' }" />
      <span class="min-w-0 truncate text-[13px] font-bold">{{ modelLabel }}</span>
      <span class="min-w-0 truncate text-xs text-muted-foreground">{{ sub() }}</span>
      <span class="flex-1" />
      <div class="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          :title="starred ? t('viewer.unstarItem') : t('viewer.starItem')"
          :aria-label="starred ? t('viewer.unstarItem') : t('viewer.starItem')"
          :aria-pressed="starred"
          @click.stop="$emit('toggle-star')"
        >
          <StarIcon class="size-3.5" :class="starred ? 'fill-current text-warning' : 'text-muted-foreground'" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          :title="itemHidden ? t('viewer.restoreItem') : t('viewer.hideItem')"
          :aria-label="itemHidden ? t('viewer.restoreItem') : t('viewer.hideItem')"
          :aria-pressed="itemHidden"
          @click.stop="$emit('toggle-hidden')"
        >
          <EyeIcon v-if="itemHidden" class="size-3.5 text-muted-foreground" />
          <XIcon v-else class="size-3.5 text-muted-foreground" />
        </Button>
        <Button as-child variant="ghost" size="icon-xs" :title="t('viewer.openOutput')" :aria-label="t('viewer.openOutput')">
          <a :href="outputUrl(job.file || '')" target="_blank" rel="noreferrer">
            <ExternalLinkIcon class="size-3.5" />
          </a>
        </Button>
        <Button as-child variant="ghost" size="icon-xs" :title="t('viewer.downloadOutput')" :aria-label="t('viewer.downloadOutput')">
          <a :href="downloadUrl(job.file || '')">
            <DownloadIcon class="size-3.5" />
          </a>
        </Button>
      </div>
    </div>
    <ScaledFrame :raw-url="rawUrl" :rw="rw" :ar="ar" :height="height" :scale="scale" />
  </div>
</template>
