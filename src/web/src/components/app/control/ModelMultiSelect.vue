<script setup lang="ts">
import { ChevronDownIcon } from '@lucide/vue';
import { toast } from 'vue-sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import type { Model } from '@/types';

const store = useControlStore();

function isRunnable(m: Model) {
  return m.enabled && Number(m.keys) > 0;
}

function onPick(m: Model) {
  if (!isRunnable(m)) {
    toast(
      !m.enabled
        ? t('modelSelect.disabledToast', { label: m.label })
        : t('modelSelect.missingKeysToast', { label: m.label }),
    );
    return;
  }
  store.toggleModel(m.id);
}

function onRowKeydown(e: KeyboardEvent, m: Model) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  onPick(m);
}
</script>

<template>
  <Popover>
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
      <div class="flex items-center gap-2 px-1 pb-2">
        <strong class="text-xs uppercase tracking-wider text-muted-foreground">{{ t('modelSelect.models') }}</strong>
        <div class="ml-auto flex gap-1.5">
          <Button variant="ghost" size="xs" @click="store.selectAll('models')">{{ t('modelSelect.all') }}</Button>
          <Button variant="ghost" size="xs" @click="store.selectNone('models')">{{ t('modelSelect.none') }}</Button>
        </div>
      </div>
      <div class="grid max-h-[min(50vh,360px)] gap-1.5 overflow-y-auto pr-1">
          <div
            v-for="m in store.models"
            :key="m.id"
            role="button"
            tabindex="0"
            class="flex items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors outline-none"
            :class="[
              store.selModels.includes(m.id) ? 'border-primary bg-accent' : 'hover:border-muted-foreground/40',
              !isRunnable(m) ? 'cursor-not-allowed opacity-55' : '',
            ]"
            :title="!isRunnable(m) ? (!m.enabled ? t('modelSelect.disabledInConfig') : t('modelSelect.noKeysAvailable')) : ''"
            @click="onPick(m)"
            @keydown="onRowKeydown($event, m)"
          >
            <Checkbox class="pointer-events-none" :model-value="store.selModels.includes(m.id)" tabindex="-1" />
            <span class="size-2.5 shrink-0 rounded-full" :style="{ background: m.color || '#888' }" />
            <span class="flex-1">
              <span class="font-semibold">{{ m.label }}</span>
              <span class="text-xs text-muted-foreground">
                · {{ m.vision ? '' : `${t('modelSelect.textOnly')} · ` }}{{ t('modelSelect.keysCount', { count: m.keys }, m.keys) }}{{ m.keys ? '' : ' ⚠' }}{{ m.enabled ? '' : ` · ${t('modelSelect.disabled')}` }}
              </span>
            </span>
          </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
