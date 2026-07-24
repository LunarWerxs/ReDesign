<script setup lang="ts">
import { computed, ref } from 'vue';
import { CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon } from '@lucide/vue';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ModelRow from './ModelRow.vue';
import { useControlStore } from '@/stores/control';
import { providerLabel } from '@/lib/providers';
import { t } from '@/i18n';
import type { Model } from '@/types';

const store = useControlStore();
const emit = defineEmits<{ browse: [] }>();

const pickerOpen = ref(false);
const search = ref('');
const showAll = ref(false);

function openBrowse() {
  // Hand off to the browse dialog (mounted by the parent); close this popover first.
  pickerOpen.value = false;
  emit('browse');
}

const q = computed(() => search.value.trim().toLowerCase());

function matches(m: Model) {
  if (!q.value) return true;
  return (
    m.label.toLowerCase().includes(q.value) ||
    (m.apiModel || '').toLowerCase().includes(q.value) ||
    (m.provider || '').toLowerCase().includes(q.value) ||
    providerLabel(m.provider).toLowerCase().includes(q.value)
  );
}

const filtered = computed(() => store.models.filter(matches));

/**
 * Top tier, "Selected": everything currently ticked, plus everything starred, with the starred
 * ones first — a star means "keep this at the very top", so it outranks a plain tick. It is
 * deliberately a UNION and not just the ticked set: a starred-but-unticked model is exactly the
 * one-click pick the star exists for, and burying it in the drawer would defeat starring.
 * Members are listed flat, with no provider sub-headings: at this point the owner has already
 * chosen these, so which vendor they came from is noise (the provider grouping is a way to
 * FIND a model, and it stays where finding happens — the "All models" drawer below).
 */
const pinned = computed(() => [
  ...filtered.value.filter((m) => m.starred),
  ...filtered.value.filter((m) => !m.starred && store.selModels.includes(m.id)),
]);
const pinnedIds = computed(() => new Set(pinned.value.map((m) => m.id)));
const rest = computed(() => filtered.value.filter((m) => !pinnedIds.value.has(m.id)));

// Group the remaining models by provider (VS Code Copilot-style sections).
const restGroups = computed(() => {
  const groups = new Map<string, Model[]>();
  for (const m of rest.value) {
    const key = m.provider || 'other';
    const arr = groups.get(key);
    if (arr) arr.push(m);
    else groups.set(key, [m]);
  }
  return [...groups.entries()].map(([provider, models]) => ({
    provider,
    label: providerLabel(provider) || t('modelSelect.allModels'),
    models,
  }));
});

// A search forces the "All models" drawer open so matches aren't hidden behind it.
const restOpen = computed(() => showAll.value || !!q.value);
// Keep the (empty) Selected header on screen when something IS pinned but the search hides it,
// so the section doesn't silently vanish mid-typing.
const anyPinned = computed(() => store.models.some((m) => m.starred || store.selModels.includes(m.id)));
</script>

<template>
  <Popover v-model:open="pickerOpen">
    <PopoverTrigger as-child>
      <Button variant="outline" class="min-w-[150px] justify-between" :title="t('modelSelect.chooseModelsTitle')">
        <span>{{ t('modelSelect.models') }}</span>
        <span class="ml-auto text-muted-foreground"
          >{{ store.selModels.length }}/{{ store.runnableModelIds.length }}</span
        >
        <ChevronDownIcon class="size-4 text-muted-foreground" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" :collision-padding="12" class="w-[min(520px,calc(100vw-2rem))] p-2">
      <div class="flex items-center gap-2 px-1 pb-1">
        <strong class="text-xs uppercase tracking-wider text-muted-foreground">{{ t('modelSelect.models') }}</strong>
        <div class="ml-auto flex gap-1.5">
          <Button variant="ghost" size="xs" @click="store.selectAll('models')">{{ t('modelSelect.all') }}</Button>
          <Button variant="ghost" size="xs" @click="store.selectNone('models')">{{ t('modelSelect.none') }}</Button>
        </div>
      </div>

      <div class="px-1 pb-1.5">
        <div class="relative">
          <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="search" :placeholder="t('modelSelect.searchPlaceholder')" class="h-8 pl-8" />
        </div>
      </div>

      <div class="grid max-h-[min(50vh,380px)] gap-0.5 overflow-y-auto pr-1">
        <p v-if="!filtered.length" class="px-1 py-3 text-center text-xs text-muted-foreground">
          {{ t('modelSelect.noMatches') }}
        </p>

        <!-- Selected tier: ticked + starred, starred first, no provider sub-headings -->
        <template v-if="pinned.length || (anyPinned && !q)">
          <div class="flex items-center gap-1.5 px-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <CheckIcon class="size-3 text-muted-foreground" />
            {{ t('modelSelect.selected') }}
          </div>
          <ModelRow v-for="m in pinned" :key="m.id" :model="m" />
          <p v-if="!pinned.length" class="px-1 pb-1 text-xs text-muted-foreground">{{ t('modelSelect.selectedEmpty') }}</p>
        </template>

        <!-- All models drawer (grouped by provider) -->
        <template v-if="rest.length">
          <button
            type="button"
            class="mt-0.5 flex items-center gap-1.5 rounded-md px-1 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground outline-none hover:text-foreground"
            @click="showAll = !showAll"
          >
            <ChevronDownIcon class="size-3.5 transition-transform" :class="restOpen ? 'rotate-0' : '-rotate-90'" />
            {{ t('modelSelect.allModels') }}
            <span class="text-muted-foreground/70">({{ rest.length }})</span>
          </button>
          <div v-show="restOpen" class="grid gap-0.5">
            <template v-for="g in restGroups" :key="g.provider">
              <div class="px-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">{{ g.label }}</div>
              <ModelRow v-for="m in g.models" :key="m.id" :model="m" />
            </template>
          </div>
        </template>
      </div>

      <div class="mt-1 border-t pt-1">
        <Button variant="ghost" size="sm" class="w-full justify-start text-muted-foreground" @click="openBrowse">
          <PlusIcon class="size-3.5" />
          {{ t('browseModels.trigger') }}
        </Button>
      </div>
    </PopoverContent>
  </Popover>
</template>
