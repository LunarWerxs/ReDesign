<script setup lang="ts">
import { CheckIcon, Trash2Icon } from '@lucide/vue';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/i18n';

withDefaults(
  defineProps<{
    name: string;
    src: string;
    badge?: string;
    selected: boolean;
    removable?: boolean;
    previewable?: boolean;
    size?: 'default' | 'compact';
  }>(),
  { size: 'default' },
);
const emit = defineEmits<{ (e: 'toggle'): void; (e: 'remove'): void; (e: 'preview'): void }>();

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  emit('toggle');
}

function onPreviewKeydown(e: KeyboardEvent) {
  e.stopPropagation();
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  emit('preview');
}

function onFooterClick(e: MouseEvent, previewable?: boolean) {
  if (!previewable) return;
  e.stopPropagation();
  emit('preview');
}
</script>

<template>
  <div
    role="button"
    tabindex="0"
    class="group relative overflow-hidden rounded-lg border bg-card text-left transition-colors"
    :class="selected ? 'border-primary ring-1 ring-primary' : 'hover:border-muted-foreground/40'"
    @click="emit('toggle')"
    @keydown="onKeydown"
  >
    <Tooltip v-if="removable">
      <TooltipTrigger as-child>
        <button
          type="button"
          :aria-label="t('input.removeThisInput')"
          class="absolute left-2 top-2 z-10 grid size-6 place-items-center rounded-md border border-white/30 bg-black/55 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100 focus-visible:opacity-100"
          @click.stop="emit('remove')"
        >
          <Trash2Icon class="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{{ t('input.removeThisInput') }}</TooltipContent>
    </Tooltip>
    <span
      class="absolute right-2 top-2 z-10 grid size-5 place-items-center rounded-md border transition-colors"
      :class="selected ? 'border-primary bg-primary text-primary-foreground' : 'border-white/40 bg-black/50 text-transparent'"
    >
      <CheckIcon class="size-3.5" />
    </span>
    <img
      loading="lazy"
      :src="src"
      alt=""
      class="block w-full bg-black object-cover"
      :class="size === 'compact' ? 'h-14' : 'h-[110px]'"
    />
    <span
      class="flex items-center justify-between gap-1.5 px-2.5 py-1.5 text-xs"
      :class="previewable ? 'cursor-zoom-in hover:bg-muted/60' : ''"
      :title="previewable ? t('input.previewName', { name }) : undefined"
      :tabindex="previewable ? 0 : undefined"
      :role="previewable ? 'button' : undefined"
      @click="onFooterClick($event, previewable)"
      @keydown="previewable ? onPreviewKeydown($event) : undefined"
    >
      <span class="truncate" :title="name">{{ name }}</span>
      <span
        v-if="badge"
        class="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground"
        >{{ badge }}</span
      >
    </span>
  </div>
</template>
