<script setup lang="ts">
import { computed } from 'vue';
import { ChevronDownIcon, PencilIcon, PlusIcon, Trash2Icon } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useControlStore } from '@/stores/control';
import { useTooltipConfig } from '@/lib/tooltip-config';
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
const { enabled: tooltipsEnabled } = useTooltipConfig();

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
      <h3 class="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('keyHealth.otherKeyPools') }}</h3>
      <span class="text-xs text-muted-foreground">{{ orphanPools.length }}</span>
    </div>
    <!-- The card frame sits on a plain wrapper: Collapsible owns its own shape and colour. -->
    <div v-for="pool in orphanPools" :key="pool.pool" class="mb-2.5 overflow-hidden rounded-lg border bg-card">
      <Collapsible v-slot="{ open: poolOpen }" :default-open="false">
        <div class="flex items-center gap-1 bg-muted/40 px-3 py-2.5 text-sm">
          <CollapsibleTrigger as-child>
            <button type="button" class="flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2 text-start outline-none">
              <strong>{{ poolName(pool) }}</strong>
              <span class="flex items-center gap-1.5">
                <Tooltip v-for="b in badges(pool)" :key="b.label">
                  <TooltipTrigger as-child>
                    <span
                      class="grid size-5 place-items-center rounded-full text-2xs font-semibold text-white"
                      :class="b.cls"
                      >{{ b.n }}</span
                    >
                  </TooltipTrigger>
                  <TooltipContent>{{ b.label }}</TooltipContent>
                </Tooltip>
              </span>
              <span class="ms-auto text-xs text-muted-foreground" :title="t('keyHealth.totalKeysInPool')">{{ pool.total }}</span>
            </button>
          </CollapsibleTrigger>
          <Tooltip v-if="poolOpen">
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon-xs"
                :aria-label="t('keyHealth.addApiKey')"
                @click="emit('add-key', pool.pool)"
              >
                <PlusIcon class="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t('keyHealth.addApiKey') }}</TooltipContent>
          </Tooltip>
          <CollapsibleTrigger as-child>
            <button
              type="button"
              class="grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              :title="tooltipsEnabled ? t('keyHealth.toggleKeys') : undefined"
              :aria-label="t('keyHealth.toggleKeys')"
            >
              <ChevronDownIcon class="size-4 transition-transform" :class="poolOpen ? 'rotate-180' : ''" />
            </button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div class="px-3 py-1">
            <div
              v-for="(k, i) in sortedEntries(pool.entries)"
              :key="i"
              class="group/key flex items-center gap-2 border-t py-1.5 text-xs first:border-t-0"
            >
              <Tooltip>
                <TooltipTrigger as-child>
                  <span
                    class="size-2.5 shrink-0 rounded-full"
                    :class="keyDot[k.status] || 'bg-muted-foreground'"
                  />
                </TooltipTrigger>
                <TooltipContent>{{ dotLabel[k.status] || k.status }}</TooltipContent>
              </Tooltip>
              <code class="font-mono">{{ k.mask }}</code>
              <span class="text-muted-foreground" :title="t('keyHealth.successesFailures')">✓{{ k.successes }} ✗{{ k.failures }}</span>
              <!-- i18n-ignore -->
              <span v-if="k.cooldownRemainingSec" class="text-muted-foreground" :title="t('keyHealth.cooldownRemaining')">{{ k.cooldownRemainingSec }}s</span>
              <span class="flex-1" />
              <Tooltip v-if="k.lastError">
                <TooltipTrigger as-child>
                  <span class="truncate text-muted-foreground">{{ k.lastError.slice(0, 24) }}</span>
                </TooltipTrigger>
                <TooltipContent class="max-w-xs">{{ k.lastError }}</TooltipContent>
              </Tooltip>
              <!-- Row actions fade in on row hover or keyboard focus; the fade lives on a plain
                   wrapper because Button owns its own effects. -->
              <span class="flex shrink-0 items-center opacity-0 transition-opacity group-hover/key:opacity-100 has-focus-visible:opacity-100">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      :aria-label="t('keyHealth.editApiKey')"
                      @click="emit('edit-key', pool.pool, k)"
                    >
                      <PencilIcon class="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{{ t('keyHealth.editApiKey') }}</TooltipContent>
                </Tooltip>
              </span>
              <span class="flex shrink-0 items-center opacity-0 transition-opacity group-hover/key:opacity-100 has-focus-visible:opacity-100">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      :aria-label="t('keyHealth.deleteApiKey')"
                      @click="deleteKey(pool.pool, k)"
                    >
                      <Trash2Icon class="size-3.5 text-destructive" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{{ t('keyHealth.deleteApiKey') }}</TooltipContent>
                </Tooltip>
              </span>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  </div>
</template>
