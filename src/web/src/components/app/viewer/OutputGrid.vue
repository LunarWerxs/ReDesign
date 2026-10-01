<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useEventListener } from '@vueuse/core';
import { ChevronLeftIcon, ChevronRightIcon } from '@lucide/vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/stores/viewer';
import { armFrameFocusGuard, useFrameFocusGuard } from '@/composables/useFrameFocusGuard';
import type { Model, Prompt } from '@/types';
import ReferenceCard from './ReferenceCard.vue';
import OutputCard from './OutputCard.vue';
import ErrorCard from './ErrorCard.vue';
import ArenaDuel from './ArenaDuel.vue';
import ViewerToolbar from './ViewerToolbar.vue';
import { t } from '@/i18n';

const store = useViewerStore();
const router = useRouter();

// Previews that autofocus themselves on load would otherwise scroll the page to whichever one
// won the race. Re-arm on every run change, since that's when a fresh batch of frames loads.
useFrameFocusGuard();
watch(() => store.runId, () => armFrameFocusGuard(), { immediate: true });

const modelMap = computed(() => new Map<string, Model>((store.manifest?.models || []).map((m) => [m.id, m])));
const promptMap = computed(() => new Map<string, Prompt>((store.manifest?.prompts || []).map((p) => [p.id, p])));

function modelLabel(id: string) {
  return modelMap.value.get(id)?.label || id;
}
function modelColor(id: string) {
  return modelMap.value.get(id)?.color ?? ''; // no colour: bg-model-dot falls back to its theme grey
}
function promptLabel(id: string) {
  return promptMap.value.get(id)?.label || id;
}

/** A single job's retry (ErrorCard's per-card button). Always exactly one job, so it always
 *  lands in exactly one run — jump the viewer to it rather than leaving the user on this stale
 *  page (store.retryJobs already toasted the outcome either way). */
async function retryJob(jobId: string) {
  const result = await store.retryJobs([jobId]);
  const target = result?.runIds[0];
  if (target) void router.push({ path: '/viewer', query: { run: target } });
}

// One at a time: ←/→ page, Esc goes back to the grid. Typing in a note or a field is left alone.
// A click inside the shown page gives the keyboard to that sandboxed frame, so the on-screen
// arrows stay the way to page from there.
useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (!store.focusJob || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
  const action = { ArrowLeft: () => store.stepFocus(-1), ArrowRight: () => store.stepFocus(1), Escape: () => store.closeFocus() }[event.key];
  if (!action) return;
  event.preventDefault();
  action();
});

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
  <ViewerToolbar v-if="store.manifest" />
  <div v-if="store.manifest?.mock" class="mx-4.5 mt-4.5 flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
    <Badge variant="secondary">{{ t('runFlyout.mockBadge') }}</Badge>
    {{ t('viewer.mockRunNotice') }}
  </div>
  <ArenaDuel />
  <div
    v-if="store.grouped.length"
    class="grid grid-cols-(--grid-cols) gap-4.5 p-4.5"
    :style="{ '--grid-cols': `repeat(${store.cols}, minmax(0, 1fr))` }"
  >
    <template v-for="group in store.grouped" :key="group.input.id">
      <div class="col-span-full">
        <h2 class="m-0 mt-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {{ group.input.name }}
          <span class="text-xs font-normal text-muted-foreground/70">· {{ t('viewer.outputsCount', { count: group.okCount }, group.okCount) }}</span>
        </h2>
      </div>
      <ReferenceCard :input="group.input" :run-id="store.manifest?.runId ?? ''" :spec-version="store.manifest?.specVersion" />
      <template v-for="job in group.jobs" :key="job.id">
        <ErrorCard
          v-if="job.status === 'error' || job.status === 'skipped'"
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
          :retry-disabled="store.isLive"
          @toggle-star="store.toggleItemStarred(job.id)"
          @toggle-hidden="store.toggleItemHidden(job.id)"
          @retry="retryJob(job.id)"
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
          :run-id="store.manifest?.runId"
          @toggle-star="store.toggleItemStarred(job.id)"
          @toggle-hidden="store.toggleItemHidden(job.id)"
          @focus="store.openFocus(job.id)"
        />
        <textarea
          class="col-span-full min-h-8 rounded border bg-background p-2 text-xs"
          :value="store.review.notes[job.id] || ''"
          :placeholder="t('viewer.reviewNotePlaceholder')"
          @change="store.setReviewNote(job.id, ($event.target as HTMLTextAreaElement).value)"
        />
      </template>
    </template>
  </div>
  <!-- v-html: emptyMsg is our own i18n string (it carries inline markup), never model output. -->
  <div v-else class="p-16 text-center text-muted-foreground" v-html="emptyMsg" />

  <!-- One at a time: keyed per output so each one opens fresh (its own contrast and screenshot state). -->
  <OutputCard
    v-if="store.focusJob"
    :key="store.focusJob.id"
    focused
    :job="store.focusJob"
    :model-label="modelLabel(store.focusJob.modelId)"
    :model-color="modelColor(store.focusJob.modelId)"
    :prompt-label="promptLabel(store.focusJob.promptId)"
    :rw="store.zoom"
    :ar="store.aspect"
    height="aspect"
    :scale="1"
    :starred="store.isItemStarred(store.focusJob.id)"
    :item-hidden="store.isItemHidden(store.focusJob.id)"
    :run-id="store.manifest?.runId"
    @toggle-star="store.toggleItemStarred(store.focusJob.id)"
    @toggle-hidden="store.toggleFocusedHidden()"
    @close="store.closeFocus()"
  >
    <template #leading>
      <div class="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          :aria-label="t('viewer.focusPrevious')"
          :title="t('viewer.focusPrevious')"
          :disabled="store.focusIndex <= 0"
          @click="store.stepFocus(-1)"
        >
          <ChevronLeftIcon class="size-4" />
        </Button>
        <span class="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
          {{ t('viewer.focusPosition', { index: store.focusIndex + 1, total: store.focusList.length }) }}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          :aria-label="t('viewer.focusNext')"
          :title="t('viewer.focusNext')"
          :disabled="store.focusIndex >= store.focusList.length - 1"
          @click="store.stepFocus(1)"
        >
          <ChevronRightIcon class="size-4" />
        </Button>
      </div>
    </template>
  </OutputCard>
</template>
