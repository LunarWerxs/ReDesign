<script setup lang="ts">
import { computed } from 'vue';
import { ChevronDownIcon, PencilIcon, PlusIcon, Trash2Icon } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import type { KeyEntry, KeyPool } from '@/types';

const props = defineProps<{
  badges: (p?: KeyPool) => { n: number; label: string; cls: string }[];
  sortedEntries: (entries: KeyEntry[]) => KeyEntry[];
  keyDot: Record<string, string>;
  dotLabel: Record<string, string>;
  poolLabel: (pool?: string) => string;
  deleteKey: (pool: string, entry: KeyEntry) => Promise<void>;
}>();

const emit = defineEmits<{
  'add-key': [pool: string];
  'edit-key': [pool: string, entry: KeyEntry];
}>();

const store = useControlStore();

// Pools not claimed by any active model still need somewhere to live.
const orphanPools = computed(() => {
  const owned = new Set(store.models.map((m) => m.keyEnv));
  return (store.keys?.pools || []).filter((p) => !owned.has(p.pool));
});

function poolName(p: KeyPool) {
  return props.poolLabel(p.pool);
}
</script>

<template>
  <!-- Key pools with no owning model still need a home. -->
  <div v-if="orphanPools.length" class="mt-4">
    <div class="mb-2 flex items-center gap-2">
      <h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t('keyHealth.otherKeyPools') }}</h3>
      <span class="text-xs text-muted-foreground">{{ orphanPools.length }}</span>
    </div>
    <Collapsible
      v-for="pool in orphanPools"
      :key="pool.pool"
      v-slot="{ open: poolOpen }"
      :default-open="false"
      class="mb-2.5 overflow-hidden rounded-lg border bg-card"
    >
      <div class="flex items-center gap-1 bg-muted/40 px-3 py-2.5 text-sm">
        <CollapsibleTrigger as-child>
          <button type="button" class="flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2 text-left outline-none">
            <strong>{{ poolName(pool) }}</strong>
            <span class="flex items-center gap-1.5">
              <Tooltip v-for="b in badges(pool)" :key="b.label">
                <TooltipTrigger as-child>
                  <span
                    class="grid size-5 place-items-center rounded-full text-[11px] font-semibold text-white"
                    :class="b.cls"
                    >{{ b.n }}</span
                  >
                </TooltipTrigger>
                <TooltipContent>{{ b.label }}</TooltipContent>
              </Tooltip>
            </span>
            <span class="ml-auto text-xs text-muted-foreground" :title="t('keyHealth.totalKeysInPool')">{{ pool.total }}</span>
          </button>
        </CollapsibleTrigger>
        <Button
          v-if="poolOpen"
          variant="ghost"
          size="icon-xs"
          :title="t('keyHealth.addApiKey')"
          :aria-label="t('keyHealth.addApiKey')"
          @click="emit('add-key', pool.pool)"
        >
          <PlusIcon class="size-3.5" />
        </Button>
        <CollapsibleTrigger as-child>
          <button
            type="button"
            class="grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            :title="t('keyHealth.toggleKeys')"
            :aria-label="t('keyHealth.toggleKeys')"
          >
            <ChevronDownIcon class="size-4 transition-transform" :class="poolOpen ? 'rotate-180' : ''" />
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent class="px-3 py-1">
        <div
          v-for="(k, i) in sortedEntries(pool.entries)"
          :key="i"
          class="group/key flex items-center gap-2 border-t py-1.5 text-xs first:border-t-0"
        >
          <span
            class="size-2.5 shrink-0 rounded-full"
            :class="keyDot[k.status] || 'bg-muted-foreground'"
            :title="dotLabel[k.status] || k.status"
          />
          <span class="font-mono">{{ k.mask }}</span>
          <span class="text-muted-foreground" :title="t('keyHealth.successesFailures')">✓{{ k.successes }} ✗{{ k.failures }}</span>
          <!-- i18n-ignore -->
          <span v-if="k.cooldownRemainingSec" class="text-muted-foreground" :title="t('keyHealth.cooldownRemaining')">{{ k.cooldownRemainingSec }}s</span>
          <span class="flex-1" />
          <span v-if="k.lastError" class="truncate text-muted-foreground" :title="k.lastError">{{ k.lastError.slice(0, 24) }}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            :title="t('keyHealth.editApiKey')"
            :aria-label="t('keyHealth.editApiKey')"
            class="opacity-0 transition-opacity group-hover/key:opacity-100 focus-visible:opacity-100"
            @click="emit('edit-key', pool.pool, k)"
          >
            <PencilIcon class="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            :title="t('keyHealth.deleteApiKey')"
            :aria-label="t('keyHealth.deleteApiKey')"
            class="text-destructive opacity-0 transition-opacity group-hover/key:opacity-100 focus-visible:opacity-100"
            @click="deleteKey(pool.pool, k)"
          >
            <Trash2Icon class="size-3.5" />
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  </div>
</template>
