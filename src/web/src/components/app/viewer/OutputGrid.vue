<script setup lang="ts">
import { computed } from 'vue';
import { Badge } from '@/components/ui/badge';
import { useViewerStore } from '@/stores/viewer';
import type { Model, Prompt } from '@/types';
import ReferenceCard from './ReferenceCard.vue';
import OutputCard from './OutputCard.vue';
import ErrorCard from './ErrorCard.vue';
import { t } from '@/i18n';

const store = useViewerStore();

const modelMap = computed(() => new Map<string, Model>((store.manifest?.models || []).map((m) => [m.id, m])));
const promptMap = computed(() => new Map<string, Prompt>((store.manifest?.prompts || []).map((p) => [p.id, p])));

function modelLabel(id: string) {
  return modelMap.value.get(id)?.label || id;
}
function modelColor(id: string) {
  return modelMap.value.get(id)?.color || '#888';
}
function promptLabel(id: string) {
  return promptMap.value.get(id)?.label || id;
}

const emptyMsg = computed(() => {
  const m = store.manifest;
  if (!store.runId)
    return t('viewer.noRunsYet', { link: `<a class="underline" href="/">${t('viewer.controlPanel')}</a>` });
  if (!m) return t('viewer.runNotFound');
  if (store.isLive)
    return m.status === 'queued' ? t('viewer.queuedStatus') : t('viewer.runningStatus');
  return t('viewer.noOutputsMatch');
});
</script>

<template>
  <div v-if="store.manifest?.mock" class="mx-[18px] mt-[18px] flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
    <Badge variant="secondary">{{ t('runFlyout.mockBadge') }}</Badge>
    {{ t('viewer.mockRunNotice') }}
  </div>
  <div
    v-if="store.grouped.length"
    class="grid gap-[18px] p-[18px]"
    :style="{ gridTemplateColumns: `repeat(${store.cols}, minmax(0, 1fr))` }"
  >
    <template v-for="group in store.grouped" :key="group.input.id">
      <div class="col-span-full">
        <h2 class="m-0 mt-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {{ group.input.name }}
          <span class="text-xs font-normal text-muted-foreground/70">· {{ t('viewer.outputsCount', { count: group.okCount }, group.okCount) }}</span>
        </h2>
      </div>
      <ReferenceCard :input="group.input" />
      <template v-for="job in group.jobs" :key="job.id">
        <ErrorCard
          v-if="job.status === 'error'"
          :job="job"
          :model-label="modelLabel(job.modelId)"
          :model-color="modelColor(job.modelId)"
          :prompt-label="promptLabel(job.promptId)"
          :rw="store.zoom"
          :ar="store.aspect"
          :height="store.height"
          :scale="store.previewScale"
          :starred="store.isItemStarred(job.id)"
          :item-hidden="store.isItemHidden(job.id)"
          @toggle-star="store.toggleItemStarred(job.id)"
          @toggle-hidden="store.toggleItemHidden(job.id)"
        />
        <OutputCard
          v-else
          :job="job"
          :model-label="modelLabel(job.modelId)"
          :model-color="modelColor(job.modelId)"
          :prompt-label="promptLabel(job.promptId)"
          :rw="store.zoom"
          :ar="store.aspect"
          :height="store.height"
          :scale="store.previewScale"
          :starred="store.isItemStarred(job.id)"
          :item-hidden="store.isItemHidden(job.id)"
          @toggle-star="store.toggleItemStarred(job.id)"
          @toggle-hidden="store.toggleItemHidden(job.id)"
        />
      </template>
    </template>
  </div>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div v-else class="p-16 text-center text-muted-foreground" v-html="emptyMsg" />
</template>
