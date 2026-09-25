<script setup lang="ts">
// Anonymous A/B duel over the current run (Chatbot Arena style): two finished outputs of one
// input from two different models, names hidden until the pick. Each pick feeds the per-model
// Elo board kept by the server (src/arena.ts); the store draws the next pair right after.
import { ScaleIcon, SkipForwardIcon, Undo2Icon, XIcon } from '@lucide/vue';
import { computed } from 'vue';
import { Button } from '@/components/ui/button';
import { outputRawUrl } from '@/lib/api';
import { useViewerStore } from '@/stores/viewer';
import ScaledFrame from './ScaledFrame.vue';
import { t } from '@/i18n';

const store = useViewerStore();
const sides = computed(() => {
  const pair = store.arenaPair;
  if (!pair) return [];
  return pair.map((job, i) => ({
    job,
    side: i as 0 | 1,
    name: i === 0 ? t('viewer.arenaSideA') : t('viewer.arenaSideB'),
    url: outputRawUrl(job.file || '', { measure: store.height === 'auto' }),
  }));
});
</script>

<template>
  <section v-if="store.arenaPair" class="mx-[18px] mt-[18px] rounded-lg border bg-card p-3" :aria-label="t('viewer.arenaTitle')">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <ScaleIcon class="size-4 text-muted-foreground" />
      <span class="text-sm font-semibold">{{ t('viewer.arenaTitle') }}</span>
      <span class="text-xs text-muted-foreground">{{ t('viewer.arenaHint') }}</span>
      <span class="flex-1" />
      <Button type="button" variant="ghost" size="sm" :disabled="store.arenaBusy" @click="store.nextArenaPair()">
        <SkipForwardIcon class="size-3.5" /> {{ t('viewer.arenaSkip') }}
      </Button>
      <Button type="button" variant="ghost" size="sm" :disabled="store.arenaBusy || !store.arenaBoard?.votes" @click="store.undoArenaVote()">
        <Undo2Icon class="size-3.5" /> {{ t('viewer.arenaUndo') }}
      </Button>
      <Button type="button" variant="ghost" size="icon-xs" :aria-label="t('viewer.arenaClose')" @click="store.stopArena()">
        <XIcon class="size-3.5" />
      </Button>
    </div>
    <div class="grid grid-cols-2 gap-3">
      <div v-for="s in sides" :key="s.job.id" class="flex min-w-0 flex-col overflow-hidden rounded-md border">
        <ScaledFrame
          :raw-url="s.url"
          :title="s.name"
          :rw="store.zoom"
          :ar="store.aspect"
          :height="store.height"
          :scale="store.previewScale"
        />
        <Button type="button" class="m-2" :disabled="store.arenaBusy" @click="store.voteArena(s.side)">
          {{ t('viewer.arenaPick', { side: s.name }) }}
        </Button>
      </div>
    </div>
  </section>
</template>
