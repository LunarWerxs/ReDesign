<script setup lang="ts">
// Per-model Elo board from the viewer's A/B duels (src/arena.ts). WHY: the votes are only worth
// collecting if they change what runs next, so the board offers to make the models that hold
// their own (a win on record and a rating at or above the starting 1500) the selected stack.
import { computed, onMounted } from 'vue';
import { toast } from 'vue-sonner';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/stores/viewer';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';

// Mirrors ARENA_BASE_RATING in src/arena.ts: every model starts here before its first vote.
const BASE_RATING = 1500;
const SHOWN = 8;

const store = useViewerStore();
const controlStore = useControlStore();
onMounted(() => void store.loadArenaBoard());

const standings = computed(() => store.arenaBoard?.standings || []);
// Winners still configured and runnable, best first; losers and never-won models drop out.
const winningStack = computed(() => {
  const runnable = new Set(controlStore.runnableModelIds);
  return standings.value.filter((s) => s.wins > 0 && s.rating >= BASE_RATING && runnable.has(s.modelId)).map((s) => s.modelId);
});

function useWinningStack() {
  const ids = winningStack.value;
  if (!ids.length) return;
  const kept = new Set(ids);
  controlStore.selModels = ids;
  controlStore.modelQty = Object.fromEntries(Object.entries(controlStore.modelQty).filter(([id]) => kept.has(id)));
  toast.success(t('viewer.arenaStackApplied', { count: ids.length }, ids.length));
}
</script>

<template>
  <div v-if="standings.length" class="px-3.5 pb-2 pt-1">
    <p class="pb-1 text-[11.5px] text-muted-foreground">{{ t('viewer.arenaBoardTitle', { count: store.arenaBoard?.votes || 0 }) }}</p>
    <ol class="m-0 list-none p-0">
      <li v-for="(s, i) in standings.slice(0, SHOWN)" :key="s.modelId" class="flex items-center gap-2 py-0.5 text-[12px]">
        <span class="w-4 shrink-0 text-right text-muted-foreground/70">{{ i + 1 }}</span>
        <span class="min-w-0 flex-1 truncate" :title="s.modelId">{{ s.label }}</span>
        <span class="shrink-0 tabular-nums font-medium">{{ s.rating }}</span>
        <span class="w-12 shrink-0 text-right tabular-nums text-muted-foreground">{{ s.wins }}-{{ s.losses }}</span>
      </li>
    </ol>
    <Button
      type="button"
      variant="outline"
      size="sm"
      class="mt-1.5 w-full"
      :disabled="!winningStack.length"
      :title="t('viewer.arenaUseStackTitle')"
      @click="useWinningStack"
    >
      {{ t('viewer.arenaUseStack', { count: winningStack.length }, winningStack.length) }}
    </Button>
  </div>
</template>
