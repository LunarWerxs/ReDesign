<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { dragAndDrop } from '@formkit/drag-and-drop/vue';
import { animations, tearDown } from '@formkit/drag-and-drop';
import {
  ActivityIcon,
  ChevronDownIcon,
  GripVerticalIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareIcon,
  Trash2Icon,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import type { KeyEntry, KeyPool, Model } from '@/types';

defineProps<{
  providerLabel: (provider?: string) => string;
  poolForModel: (m: Model) => KeyPool | undefined;
  badges: (p?: KeyPool) => { n: number; label: string; cls: string }[];
  sortedEntries: (entries: KeyEntry[]) => KeyEntry[];
  keyDot: Record<string, string>;
  dotLabel: Record<string, string>;
  poolLabel: (pool?: string) => string;
  deleteKey: (pool: string, entry: KeyEntry) => Promise<void>;
}>();

const emit = defineEmits<{
  'add-model': [];
  'edit-model': [model: Model];
  'add-key': [pool: string];
  'edit-key': [pool: string, entry: KeyEntry];
}>();

const store = useControlStore();

// File order is the manual order (drag-reorderable), not alphabetical.
const activeModels = computed(() => [...store.models]);

// Drag-to-reorder the model list, persisting the models.json array order. Same
// @formkit config as RepoYeti/DevWebUI: pointer drag + touch tap-and-hold.
const modelsParent = ref<HTMLElement>();
const modelList = ref<Model[]>([]);
const modelDragging = ref(false);
function syncModelList() {
  if (!modelDragging.value) modelList.value = [...activeModels.value];
}
watch(activeModels, syncModelList, { immediate: true });
dragAndDrop({
  parent: modelsParent,
  values: modelList,
  dragHandle: '.model-drag',
  draggingClass: 'opacity-70',
  nativeDrag: false,
  longPress: true,
  longPressDuration: 250,
  plugins: [animations()],
  onDragstart: () => (modelDragging.value = true),
  onDragend: () => {
    const ids = modelList.value.map((m) => m.id);
    void store.reorderModels(ids).finally(() => {
      modelDragging.value = false;
      syncModelList();
    });
  },
});
onBeforeUnmount(() => modelsParent.value && tearDown(modelsParent.value));
const archivedModels = computed(() =>
  [...store.archivedModels].sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true })),
);

function modelKeys(m: Model) {
  const count = Number(m.keys) || 0;
  return t('keyModel.keyCount', { count }, count);
}

function isRunnable(m: Model) {
  return !!(m.enabled && Number(m.keys) > 0);
}

async function restoreModel(model: Model) {
  await store.restoreModel(model.id);
}
</script>

<template>
  <div class="mb-2 flex items-center gap-2">
    <h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t('keyModel.modelsAndKeys') }}</h3>
    <span class="text-xs text-muted-foreground">{{ activeModels.length }}</span>
    <div class="ml-auto flex items-center gap-1">
      <Button variant="ghost" size="icon-xs" :title="t('keyModel.refreshApiKeys')" :aria-label="t('keyModel.refreshApiKeys')" @click="store.refreshKeys()">
        <RefreshCwIcon class="size-3.5" />
      </Button>
      <Button
        :variant="store.liveCheckBusy || store.liveCheckArmed ? 'destructive' : 'secondary'"
        size="xs"
        :title="store.liveCheckBusy ? t('keyModel.cancelApiKeyCheckLong') : t('keyModel.runApiKeyCheckLong')"
        :aria-label="store.liveCheckBusy ? t('keyModel.cancelApiKeyCheck') : t('keyModel.runApiKeyCheck')"
        @click="store.liveCheck()"
      >
        <SquareIcon v-if="store.liveCheckBusy" class="size-3" />
        <Loader2Icon v-else-if="store.liveCheckArmed" class="size-3" />
        <ActivityIcon v-else class="size-3" />
        {{ store.liveCheckBusy ? t('keyModel.cancel') : t('keyModel.checkKeys') }}
      </Button>
      <Button variant="ghost" size="icon-xs" :title="t('keyModel.addModel')" :aria-label="t('keyModel.addModel')" @click="emit('add-model')">
        <PlusIcon class="size-3.5" />
      </Button>
    </div>
  </div>

  <!-- Each model carries its own key pool inline; expand to manage keys. Drag the grip to reorder. -->
  <div ref="modelsParent" class="grid gap-2.5">
    <Collapsible
      v-for="model in modelList"
      :key="model.id"
      v-slot="{ open: modelOpen }"
      :default-open="false"
      class="overflow-hidden rounded-lg border bg-card"
    >
      <div class="flex items-center gap-2 px-3 py-2 text-xs">
        <button
          type="button"
          class="model-drag -ml-1 flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/40 outline-none transition-colors hover:text-muted-foreground active:cursor-grabbing"
          :aria-label="t('keyModel.dragToReorder')"
          :title="t('keyModel.dragToReorder')"
        >
          <GripVerticalIcon class="size-3.5" />
        </button>
        <span class="size-2.5 shrink-0 rounded-full" :style="{ background: model.color || '#888' }" />
        <span class="grid min-w-0 flex-1 gap-0.5">
          <span class="truncate text-sm font-semibold">{{ model.label }}</span>
          <span class="truncate text-muted-foreground">
            {{ providerLabel(model.provider) }} · {{ model.apiModel }} · {{ poolLabel(model.keyEnv) }}
          </span>
        </span>
        <span
          class="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium"
          :class="isRunnable(model) ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'"
        >
          {{ model.enabled ? modelKeys(model) : t('keyModel.disabled') }}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          :title="t('keyModel.editModel')"
          :aria-label="t('keyModel.editModel')"
          @click="emit('edit-model', model)"
        >
          <PencilIcon class="size-3.5" />
        </Button>
        <CollapsibleTrigger as-child>
          <button
            type="button"
            class="grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            :title="modelOpen ? t('keyModel.hideKeys') : t('keyModel.showKeys')"
            :aria-label="modelOpen ? t('keyModel.hideKeys') : t('keyModel.showKeys')"
          >
            <ChevronDownIcon class="size-4 transition-transform" :class="modelOpen ? 'rotate-180' : ''" />
          </button>
        </CollapsibleTrigger>
      </div>

      <CollapsibleContent class="border-t">
        <div class="flex items-center gap-2 bg-muted/30 px-3 py-1.5">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t('keyModel.keys') }}</span>
          <span class="flex items-center gap-1.5">
            <Tooltip v-for="b in badges(poolForModel(model))" :key="b.label">
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
          <Button
            class="ml-auto"
            variant="ghost"
            size="icon-xs"
            :title="t('keyModel.addApiKey')"
            :aria-label="t('keyModel.addApiKey')"
            @click="emit('add-key', model.keyEnv || '')"
          >
            <PlusIcon class="size-3.5" />
          </Button>
        </div>
        <div class="px-3 py-1">
          <p v-if="!poolForModel(model)?.entries?.length" class="py-2 text-xs text-muted-foreground">
            {{ t('keyModel.noKeysInPool') }}
          </p>
          <div
            v-for="(k, i) in sortedEntries(poolForModel(model)?.entries || [])"
            :key="i"
            class="group/key flex items-center gap-2 border-t py-1.5 text-xs first:border-t-0"
          >
            <span
              class="size-2.5 shrink-0 rounded-full"
              :class="keyDot[k.status] || 'bg-muted-foreground'"
              :title="dotLabel[k.status] || k.status"
            />
            <span class="font-mono">{{ k.mask }}</span>
            <span class="text-muted-foreground" :title="t('keyModel.successesFailures')">✓{{ k.successes }} ✗{{ k.failures }}</span>
            <!-- i18n-ignore -->
            <span v-if="k.cooldownRemainingSec" class="text-muted-foreground" :title="t('keyModel.cooldownRemaining')">{{ k.cooldownRemainingSec }}s</span>
            <span class="flex-1" />
            <span v-if="k.lastError" class="truncate text-muted-foreground" :title="k.lastError">{{ k.lastError.slice(0, 24) }}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              :title="t('keyModel.editApiKey')"
              :aria-label="t('keyModel.editApiKey')"
              class="opacity-0 transition-opacity group-hover/key:opacity-100 focus-visible:opacity-100"
              @click="emit('edit-key', model.keyEnv || '', k)"
            >
              <PencilIcon class="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              :title="t('keyModel.deleteApiKey')"
              :aria-label="t('keyModel.deleteApiKey')"
              class="text-destructive opacity-0 transition-opacity group-hover/key:opacity-100 focus-visible:opacity-100"
              @click="deleteKey(model.keyEnv || '', k)"
            >
              <Trash2Icon class="size-3.5" />
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>

    <p v-if="!activeModels.length" class="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
      {{ t('keyModel.noModels') }}
    </p>
  </div>

  <div v-if="archivedModels.length" class="mt-3 rounded-lg border border-dashed">
    <div class="flex items-center justify-between border-b px-3 py-2">
      <h4 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t('keyModel.removed') }}</h4>
      <span class="text-xs text-muted-foreground">{{ archivedModels.length }}</span>
    </div>
    <div class="grid divide-y">
      <div
        v-for="model in archivedModels"
        :key="model.id"
        class="flex min-w-0 items-center gap-2 px-3 py-2 text-xs"
      >
        <span class="size-2.5 shrink-0 rounded-full" :style="{ background: model.color || '#888' }" />
        <span class="min-w-0 flex-1 truncate">
          <span class="font-semibold">{{ model.label }}</span>
          <span class="text-muted-foreground"> · {{ providerLabel(model.provider) }}</span>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          :title="t('keyModel.restoreModel')"
          :aria-label="t('keyModel.restoreModel')"
          @click="restoreModel(model)"
        >
          <PlusIcon class="size-3.5" />
        </Button>
      </div>
    </div>
  </div>
</template>
