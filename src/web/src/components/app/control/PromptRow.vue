<script setup lang="ts">
import { computed } from 'vue';
import { PencilIcon, StarIcon } from '@lucide/vue';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import type { Prompt } from '@/types';

const props = defineProps<{ prompt: Prompt }>();
const emit = defineEmits<{ edit: [Prompt] }>();
const store = useControlStore();

const selected = computed(() => store.selPrompts.includes(props.prompt.id));

function onRowKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  store.togglePrompt(props.prompt.id);
}
</script>

<template>
  <div
    role="button"
    tabindex="0"
    class="group/prompt flex items-center gap-2 rounded-md px-2 py-1 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
    :class="selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60'"
    @click="store.togglePrompt(prompt.id)"
    @keydown="onRowKeydown"
  >
    <Checkbox class="pointer-events-none" :model-value="selected" tabindex="-1" />
    <span
      class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
      :title="prompt.label + (prompt.description ? ` · ${prompt.description}` : '')"
    >
      <span class="shrink-0 truncate font-medium">{{ prompt.label }}</span>
      <span v-if="prompt.description" class="min-w-0 flex-1 truncate text-xs text-muted-foreground">· {{ prompt.description }}</span>
    </span>

    <!-- Edit (opens the dialog, where Delete also lives): revealed on hover. -->
    <Tooltip>
      <TooltipTrigger as-child>
        <Button
          variant="ghost"
          size="icon-xs"
          :aria-label="t('promptSelect.editPrompt')"
          class="opacity-0 transition-opacity group-hover/prompt:opacity-100 focus-visible:opacity-100"
          @click.stop="emit('edit', prompt)"
          @keydown.stop
        >
          <PencilIcon class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{{ t('promptSelect.editPrompt') }}</TooltipContent>
    </Tooltip>

    <!-- Star toggle: pin this prompt to the top tier. Never toggles the row. -->
    <button
      type="button"
      class="grid size-6 shrink-0 place-items-center rounded text-muted-foreground/50 outline-none transition-colors hover:text-amber-400 focus-visible:text-amber-400"
      :class="prompt.starred ? 'text-amber-400' : ''"
      :aria-label="prompt.starred ? t('promptSelect.unstar') : t('promptSelect.star')"
      :title="prompt.starred ? t('promptSelect.unstar') : t('promptSelect.star')"
      @click.stop="store.togglePromptStarred(prompt.id)"
      @keydown.stop
    >
      <StarIcon class="size-3.5" :class="prompt.starred ? 'fill-current' : ''" />
    </button>
  </div>
</template>
