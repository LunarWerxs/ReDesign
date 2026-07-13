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
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useControlStore } from '@/stores/control';
import { useTooltipConfig } from '@/lib/tooltip-config';
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
  'import-keys': [];
}>();

const store = useControlStore();
const { enabled: tooltipsEnabled } = useTooltipConfig();

// File order is the manual order (drag-reorderable), not alphabetical.
const activeModels = computed(() => [...store.models]);

// True once at least one key exists in any pool. Drives the first-run paste CTA.
const hasAnyKeys = computed(() => (store.keys?.pools || []).some((p) => p.total > 0));

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
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon-xs" :aria-label="t('keyModel.refreshApiKeys')" @click="store.refreshKeys()">
            <RefreshCwIcon class="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t('keyModel.refreshApiKeys') }}</TooltipContent>
      </Tooltip>
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
      <Button
        variant="secondary"
        size="xs"
        :title="t('keyModel.pasteKeysTitle')"
        @click="emit('import-keys')"
      >
        <SparklesIcon class="size-3" />
        {{ t('keyModel.pasteKeys') }}
      </Button>
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon-xs" :aria-label="t('keyModel.addModel')" @click="emit('add-model')">
            <PlusIcon class="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ t('keyModel.addModel') }}</TooltipContent>
      </Tooltip>
    </div>
  </div>

  <!-- First-run: no keys anywhere yet. Lead with paste-and-autodetect. -->
  <button
    v-if="!hasAnyKeys && activeModels.length"
    type="button"
    class="mb-3 flex w-full items-center gap-3 rounded-lg border border-dashed border-primary/40 bg-primary/5 px-3 py-3 text-left transition-colors hover:bg-primary/10"
    @click="emit('import-keys')"
  >
    <SparklesIcon class="size-5 shrink-0 text-primary" />
    <span class="grid gap-0.5">
      <span class="text-sm font-semibold">{{ t('keyModel.noKeysYet') }}</span>
      <span class="text-xs text-muted-foreground">{{ t('keyModel.noKeysYetHint') }}</span>
    </span>
    <span class="ml-auto shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground">
      {{ t('keyModel.pasteKeysCta') }}
    </span>
  </button>

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
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              class="model-drag -ml-1 flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/40 outline-none transition-colors hover:text-muted-foreground active:cursor-grabbing"
              :aria-label="t('keyModel.dragToReorder')"
            >
              <GripVerticalIcon class="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{{ t('keyModel.dragToReorder') }}</TooltipContent>
        </Tooltip>
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
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-xs"
              :aria-label="t('keyModel.editModel')"
              @click="emit('edit-model', model)"
            >
              <PencilIcon class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('keyModel.editModel') }}</TooltipContent>
        </Tooltip>
        <CollapsibleTrigger as-child>
          <button
            type="button"
            class="grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            :title="tooltipsEnabled ? (modelOpen ? t('keyModel.hideKeys') : t('keyModel.showKeys')) : undefined"
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
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                class="ml-auto"
                variant="ghost"
                size="icon-xs"
                :aria-label="t('keyModel.addApiKey')"
                @click="emit('add-key', model.keyEnv || '')"
              >
                <PlusIcon class="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t('keyModel.addApiKey') }}</TooltipContent>
          </Tooltip>
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
            <Tooltip>
              <TooltipTrigger as-child>
                <span
                  class="size-2.5 shrink-0 rounded-full"
                  :class="keyDot[k.status] || 'bg-muted-foreground'"
                />
              </TooltipTrigger>
              <TooltipContent>{{ dotLabel[k.status] || k.status }}</TooltipContent>
            </Tooltip>
            <span class="font-mono">{{ k.mask }}</span>
            <span class="text-muted-foreground" :title="t('keyModel.successesFailures')">✓{{ k.successes }} ✗{{ k.failures }}</span>
            <!-- i18n-ignore -->
            <span v-if="k.cooldownRemainingSec" class="text-muted-foreground" :title="t('keyModel.cooldownRemaining')">{{ k.cooldownRemainingSec }}s</span>
            <span class="flex-1" />
            <Tooltip v-if="k.lastError">
              <TooltipTrigger as-child>
                <span class="truncate text-muted-foreground">{{ k.lastError.slice(0, 24) }}</span>
              </TooltipTrigger>
              <TooltipContent class="max-w-xs">{{ k.lastError }}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  :aria-label="t('keyModel.editApiKey')"
                  class="opacity-0 transition-opacity group-hover/key:opacity-100 focus-visible:opacity-100"
                  @click="emit('edit-key', model.keyEnv || '', k)"
                >
                  <PencilIcon class="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{{ t('keyModel.editApiKey') }}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  :aria-label="t('keyModel.deleteApiKey')"
                  class="text-destructive opacity-0 transition-opacity group-hover/key:opacity-100 focus-visible:opacity-100"
                  @click="deleteKey(model.keyEnv || '', k)"
                >
                  <Trash2Icon class="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{{ t('keyModel.deleteApiKey') }}</TooltipContent>
            </Tooltip>
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
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-xs"
              :aria-label="t('keyModel.restoreModel')"
              @click="restoreModel(model)"
            >
              <PlusIcon class="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('keyModel.restoreModel') }}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  </div>
</template>
