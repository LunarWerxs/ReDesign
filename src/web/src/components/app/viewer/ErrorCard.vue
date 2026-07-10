<script setup lang="ts">
import { EyeIcon, StarIcon, XIcon } from '@lucide/vue';
import { computed } from 'vue';
import { Button } from '@/components/ui/button';
import type { Job } from '@/types';
import type { ViewerHeight } from '@/stores/viewer';
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

const previewScale = computed(() => Math.max(0.1, props.scale || 1));
const frameAspect = computed(() =>
  typeof props.height === 'number' && props.rw
    ? props.rw / (props.height * previewScale.value)
    : props.ar / previewScale.value,
);
</script>

<template>
  <div
    class="flex flex-col overflow-hidden rounded-lg border bg-card transition-opacity"
    :class="itemHidden ? 'opacity-50 grayscale' : ''"
  >
    <div class="flex min-w-0 items-center gap-2.5 border-b px-3 py-2.5">
      <span class="size-2.5 shrink-0 rounded-full" :style="{ background: modelColor || '#888' }" />
      <span class="min-w-0 truncate text-[13px] font-bold">{{ modelLabel }}</span>
      <span class="min-w-0 truncate text-xs text-muted-foreground">{{ promptLabel }}</span>
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
      </div>
    </div>
    <div
      class="grid place-items-center bg-destructive/10 p-3.5 text-center text-destructive"
      :style="{ aspectRatio: String(frameAspect) }"
    >
      <div>
        <div>{{ t('viewer.failed') }}</div>
        <div class="mt-1.5 text-xs text-muted-foreground">{{ (job.error || '').slice(0, 140) }}</div>
      </div>
    </div>
  </div>
</template>
