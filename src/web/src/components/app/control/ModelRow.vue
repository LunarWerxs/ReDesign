<script setup lang="ts">
import { computed } from 'vue';
import { StarIcon } from '@lucide/vue';
import { toast } from 'vue-sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import QtyStepper from './QtyStepper.vue';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import type { Model } from '@/types';

const props = defineProps<{ model: Model }>();
const store = useControlStore();

const runnable = computed(() => !!(props.model.enabled && Number(props.model.keys) > 0));
const selected = computed(() => store.selModels.includes(props.model.id));

// Compact meta: capability + config state only — the key COUNT is intentionally
// omitted (a no-keys model is already dimmed with a "No keys available" tooltip).
const meta = computed(() => {
  const bits: string[] = [];
  if (!props.model.vision) bits.push(t('modelSelect.textOnly'));
  if (!props.model.enabled) bits.push(t('modelSelect.disabled'));
  return bits.length ? `· ${bits.join(' · ')}` : '';
});

function onPick() {
  const m = props.model;
  if (!runnable.value) {
    toast(
      !m.enabled
        ? t('modelSelect.disabledToast', { label: m.label })
        : t('modelSelect.missingKeysToast', { label: m.label }),
    );
    return;
  }
  store.toggleModel(m.id);
}

function onRowKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  onPick();
}
</script>

<template>
  <Tooltip :disabled="runnable">
    <TooltipTrigger as-child>
      <div
        role="button"
        tabindex="0"
        class="flex items-center gap-2 rounded-md px-2 py-1 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        :class="[
          selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60',
          !runnable ? 'cursor-not-allowed opacity-55' : '',
        ]"
        @click="onPick"
        @keydown="onRowKeydown"
      >
        <Checkbox class="pointer-events-none" :model-value="selected" tabindex="-1" />
        <span class="size-2 shrink-0 rounded-full" :style="{ background: model.color || '#888' }" />
        <span class="flex min-w-0 flex-1 items-center gap-1.5">
          <span class="truncate font-medium">{{ model.label }}</span>
          <span v-if="meta" class="shrink-0 text-xs text-muted-foreground">{{ meta }}</span>
        </span>

        <!-- Per-model quantity: how many copies to generate (default 1). Only once selected. -->
        <span v-if="selected" class="shrink-0 text-xs text-muted-foreground">×</span>
        <QtyStepper
          v-if="selected"
          :model-value="store.modelQty[model.id] ?? 1"
          :min="1"
          :max="10"
          :aria-label="t('modelSelect.quantityLabel', { label: model.label })"
          :title="t('modelSelect.quantityTitle')"
          @update:model-value="(v) => store.setModelQty(model.id, v)"
        />

        <!-- Star toggle: pin this model to the top tier. Never toggles the row. -->
        <button
          type="button"
          class="grid size-6 shrink-0 place-items-center rounded text-muted-foreground/50 outline-none transition-colors hover:text-amber-400 focus-visible:text-amber-400"
          :class="model.starred ? 'text-amber-400' : ''"
          :aria-label="model.starred ? t('modelSelect.unstar') : t('modelSelect.star')"
          :title="model.starred ? t('modelSelect.unstar') : t('modelSelect.star')"
          @click.stop="store.toggleModelStarred(model.id)"
          @keydown.stop
        >
          <StarIcon class="size-3.5" :class="model.starred ? 'fill-current' : ''" />
        </button>
      </div>
    </TooltipTrigger>
    <TooltipContent>{{ !model.enabled ? t('modelSelect.disabledInConfig') : t('modelSelect.noKeysAvailable') }}</TooltipContent>
  </Tooltip>
</template>
