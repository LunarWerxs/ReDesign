<script setup lang="ts">
import { computed } from 'vue';
import { ChevronDownIcon } from '@lucide/vue';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useViewerStore } from '@/stores/viewer';
import { t } from '@/i18n';

interface FilterItem {
  id: string;
  label: string;
  color?: string;
}

const props = withDefaults(
  defineProps<{ kind?: 'models' | 'prompts'; variant?: 'button' | 'row' }>(),
  { kind: 'models', variant: 'button' },
);

const store = useViewerStore();

const isPrompts = computed(() => props.kind === 'prompts');
const label = computed(() => (isPrompts.value ? t('filter.prompts') : t('filter.models')));
const noun = computed(() => (isPrompts.value ? t('filter.promptNoun') : t('filter.modelNoun')));
const items = computed<FilterItem[]>(() =>
  isPrompts.value ? store.manifest?.prompts || [] : store.manifest?.models || [],
);
const hidden = computed(() => (isPrompts.value ? store.hiddenPrompts : store.hiddenModels));
const visibleCount = computed(() => items.value.filter((i) => !hidden.value.includes(i.id)).length);

function isVisible(item: FilterItem) {
  return !hidden.value.includes(item.id);
}
function toggle(id: string) {
  if (isPrompts.value) store.togglePrompt(id);
  else store.toggleModel(id);
}
function onRowKeydown(e: KeyboardEvent, id: string) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  toggle(id);
}
function showAll() {
  const ids = new Set(items.value.map((i) => i.id));
  if (isPrompts.value) store.hiddenPrompts = store.hiddenPrompts.filter((id) => !ids.has(id));
  else store.hiddenModels = store.hiddenModels.filter((id) => !ids.has(id));
}
function hideAll() {
  const ids = items.value.map((i) => i.id);
  if (isPrompts.value) store.hiddenPrompts = Array.from(new Set([...store.hiddenPrompts, ...ids]));
  else store.hiddenModels = Array.from(new Set([...store.hiddenModels, ...ids]));
}
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <button
        v-if="props.variant === 'row'"
        type="button"
        class="flex w-full items-center justify-between px-3.5 py-[7px] outline-none transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        :title="t('filter.chooseVisible', { noun })"
        :disabled="!items.length"
      >
        <span class="text-[13px] text-muted-foreground">{{ label }}</span>
        <span class="flex items-center gap-2 text-[13px] font-medium text-foreground">
          <span class="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11.5px] text-muted-foreground">
            {{ visibleCount }} / {{ items.length }}
          </span>
          <ChevronDownIcon class="size-3 text-muted-foreground/60" />
        </span>
      </button>
      <Button
        v-else
        variant="outline"
        size="sm"
        class="min-w-[154px] justify-between"
        :title="t('filter.chooseVisible', { noun })"
        :disabled="!items.length"
      >
        <span>{{ label }}</span>
        <span class="ml-auto text-muted-foreground">{{ visibleCount }}/{{ items.length }}</span>
        <ChevronDownIcon class="size-4 text-muted-foreground" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" :collision-padding="12" class="w-[min(340px,calc(100vw-2rem))] p-2">
      <div class="flex items-center gap-2 px-1 pb-2">
        <strong class="text-xs uppercase tracking-wider text-muted-foreground">{{ label }}</strong>
        <div class="ml-auto flex gap-1.5">
          <Button variant="ghost" size="xs" @click="showAll">{{ t('filter.all') }}</Button>
          <Button variant="ghost" size="xs" @click="hideAll">{{ t('filter.none') }}</Button>
        </div>
      </div>
      <div class="grid max-h-[min(50vh,340px)] gap-1 overflow-y-auto pr-1">
        <div
          v-for="item in items"
          :key="item.id"
          role="button"
          tabindex="0"
          class="flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors outline-none"
          :class="isVisible(item) ? 'border-primary bg-accent' : 'hover:border-muted-foreground/40 opacity-55'"
          @click="toggle(item.id)"
          @keydown="onRowKeydown($event, item.id)"
        >
          <Checkbox class="pointer-events-none" :model-value="isVisible(item)" tabindex="-1" />
          <span v-if="item.color" class="size-2.5 shrink-0 rounded-full" :style="{ background: item.color }" />
          <span class="min-w-0 flex-1 truncate font-semibold">{{ item.label }}</span>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
