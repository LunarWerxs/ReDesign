<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue';
import { useStorage } from '@vueuse/core';
import {
  BookmarkIcon,
  CheckIcon,
  EyeIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
} from '@lucide/vue';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'vue-sonner';
import {
  buildPromptFromRecipe,
  defaultPromptBuilderRecipe,
  normalizePromptBuilderRecipe,
  PROMPT_BUILDER_QUALITY_OPTIONS,
  PROMPT_BUILDER_SCOPE_OPTIONS,
} from '@/lib/prompt-builder';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import CustomOptionDialog from './prompt-builder-dialog/CustomOptionDialog.vue';
import type {
  Prompt,
  PromptBuilderCustomOptionSnapshot,
  PromptBuilderModifierId,
  PromptBuilderOption,
  PromptBuilderRecipe,
  PromptBuilderScopeId,
} from '@/types';

const props = withDefaults(
  defineProps<{
    open: boolean;
    prompt?: Prompt | null;
  }>(),
  { prompt: null },
);

const emit = defineEmits<{
  (e: 'update:open', open: boolean): void;
  (e: 'applied'): void;
}>();

const store = useControlStore();
const savedDraft = useStorage<PromptBuilderRecipe>(
  'redesign.prompt-builder-v1',
  defaultPromptBuilderRecipe(),
);
const recipe = ref<PromptBuilderRecipe>(defaultPromptBuilderRecipe());
const bookmarkName = ref('');
const saving = ref(false);
const deleting = ref(false);
const previewOpen = ref(false);
const deleteConfirmOpen = ref(false);

const optionDialogOpen = ref(false);
const optionDeleteConfirmOpen = ref(false);
// Imperative handle onto the extracted create/edit sub-dialog (see openCreateOption /
// openEditOption callers below): its optionSaving/optionDeleting now live inside it,
// exposed as optionBusy so this dialog's own busy computed still folds them in.
const customOptionDialog = useTemplateRef<InstanceType<typeof CustomOptionDialog>>(
  'customOptionDialog',
);

function localizeBuiltIn<
  T extends { labelKey: `promptBuilder.${string}`; descriptionKey: `promptBuilder.${string}` },
>(option: T) {
  return {
    ...option,
    label: t(option.labelKey),
    description: t(option.descriptionKey),
  };
}

const scopes = computed(() => PROMPT_BUILDER_SCOPE_OPTIONS.map(localizeBuiltIn));
const builtInQualities = computed(() =>
  PROMPT_BUILDER_QUALITY_OPTIONS.map(localizeBuiltIn),
);
const builderCategories = computed(() => [
  {
    id: 'structure' as const,
    title: t('promptBuilder.structureTitle'),
    createLabel: t('promptBuilder.createStructureOption'),
    builtIns: builtInQualities.value.filter((option) => option.category === 'structure'),
    customOptions: store.builderOptions.filter((option) => option.category === 'structure'),
  },
  {
    id: 'design' as const,
    title: t('promptBuilder.designTitle'),
    createLabel: t('promptBuilder.createDesignOption'),
    builtIns: builtInQualities.value.filter((option) => option.category === 'design'),
    customOptions: store.builderOptions.filter((option) => option.category === 'design'),
  },
]);

const selectedBuiltInSet = computed(() => new Set(recipe.value.modifiers));
const selectedCustomMap = computed(
  () => new Map((recipe.value.customOptions ?? []).map((option) => [option.id, option])),
);

function displayedCustomOption(option: PromptBuilderOption): PromptBuilderOption {
  return selectedCustomMap.value.get(option.id) ?? option;
}

function customOptionHasSnapshotDrift(option: PromptBuilderOption): boolean {
  const snapshot = selectedCustomMap.value.get(option.id);
  return !!(
    snapshot &&
    (snapshot.label !== option.label ||
      snapshot.description !== option.description ||
      snapshot.instruction !== option.instruction ||
      snapshot.category !== option.category)
  );
}

const selectedScope = computed(
  () => scopes.value.find((scope) => scope.id === recipe.value.scope) ?? scopes.value[1]!,
);
const selectedBuiltIns = computed(() =>
  recipe.value.modifiers
    .map((id) => builtInQualities.value.find((option) => option.id === id))
    .filter((option): option is (typeof builtInQualities.value)[number] => !!option),
);
const selectedCustomOptions = computed(() => recipe.value.customOptions ?? []);
const selectedOptions = computed(() => [
  ...selectedBuiltIns.value.map((option) => ({ id: option.id, label: option.label })),
  ...selectedCustomOptions.value.map((option) => ({ id: option.id, label: option.label })),
]);
const reusableCustomIds = computed(() => new Set(store.builderOptions.map((option) => option.id)));
const orphanedCustomOptions = computed(() =>
  selectedCustomOptions.value.filter((option) => !reusableCustomIds.value.has(option.id)),
);
const compiledPrompt = computed(() => buildPromptFromRecipe(recipe.value));
const suggestedName = computed(() => {
  const parts = [
    selectedScope.value.label,
    ...selectedOptions.value.slice(0, 2).map((option) => option.label),
  ];
  if (selectedOptions.value.length > 2) {
    parts.push(t('promptBuilder.moreCount', { count: selectedOptions.value.length - 2 }));
  }
  return parts.join(' · ');
});
const recipeSummary = computed(() =>
  [selectedScope.value.label, ...selectedOptions.value.map((option) => option.label)].join(
    ' · ',
  ),
);
const isEditing = computed(() => !!props.prompt?.id);
const optionBusy = computed(() => customOptionDialog.value?.optionBusy ?? false);
const busy = computed(() => saving.value || deleting.value || optionBusy.value);

function close(force = false) {
  if (busy.value && !force) return;
  emit('update:open', false);
}

function onOpenChange(open: boolean) {
  if (!open && busy.value) return;
  emit('update:open', open);
}

function setScope(scope: PromptBuilderScopeId) {
  recipe.value = { ...recipe.value, scope };
}

function toggleBuiltIn(id: PromptBuilderModifierId) {
  const next = selectedBuiltInSet.value.has(id)
    ? recipe.value.modifiers.filter((optionId) => optionId !== id)
    : [...recipe.value.modifiers, id];
  recipe.value = normalizePromptBuilderRecipe({ ...recipe.value, modifiers: next });
}

function optionSnapshot(option: PromptBuilderOption): PromptBuilderCustomOptionSnapshot {
  return {
    id: option.id,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    instruction: option.instruction,
    category: option.category,
  };
}

function toggleCustomOption(option: PromptBuilderOption) {
  const selected = selectedCustomMap.value.has(option.id);
  const next = selected
    ? selectedCustomOptions.value.filter((item) => item.id !== option.id)
    : [...selectedCustomOptions.value, optionSnapshot(option)];
  recipe.value = normalizePromptBuilderRecipe({ ...recipe.value, customOptions: next });
}

function removeSavedOption(id: string) {
  recipe.value = normalizePromptBuilderRecipe({
    ...recipe.value,
    customOptions: selectedCustomOptions.value.filter((option) => option.id !== id),
  });
}

function useOnce() {
  if (busy.value) return;
  if (!props.prompt) savedDraft.value = normalizePromptBuilderRecipe(recipe.value);
  store.selPrompts = [];
  store.custom = compiledPrompt.value;
  store.customOn = true;
  store.advancedOpen = true;
  toast.success(t('promptBuilder.applied'));
  emit('applied');
  close();
}

async function bookmarkAndUse() {
  if (busy.value) return;
  saving.value = true;
  try {
    const normalized = normalizePromptBuilderRecipe(recipe.value);
    const saved = await store.savePrompt({
      id: props.prompt?.id,
      label: bookmarkName.value.trim() || suggestedName.value,
      description: t('promptBuilder.bookmarkDescription', { summary: recipeSummary.value }),
      user: buildPromptFromRecipe(normalized),
      starred: props.prompt?.starred ?? true,
      builder: normalized,
    });
    if (!saved) return;
    if (!props.prompt) savedDraft.value = normalized;
    store.selPrompts = [saved.id];
    store.customOn = false;
    emit('applied');
    close(true);
  } finally {
    saving.value = false;
  }
}

async function confirmDeleteBookmark() {
  const id = props.prompt?.id;
  if (!id || busy.value) return;
  deleting.value = true;
  try {
    if (await store.deletePrompt(id)) {
      deleteConfirmOpen.value = false;
      emit('applied');
      close(true);
    }
  } finally {
    deleting.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    let nextRecipe = normalizePromptBuilderRecipe(props.prompt?.builder ?? savedDraft.value);
    if (!props.prompt?.builder && store.builderOptionsLoaded && nextRecipe.customOptions?.length) {
      const liveOptions = new Map(store.builderOptions.map((option) => [option.id, option]));
      nextRecipe = normalizePromptBuilderRecipe({
        ...nextRecipe,
        customOptions: nextRecipe.customOptions
          .map((option) => liveOptions.get(option.id))
          .filter((option): option is PromptBuilderOption => !!option),
      });
    }
    recipe.value = nextRecipe;
    bookmarkName.value = props.prompt?.label ?? '';
    previewOpen.value = false;
    optionDialogOpen.value = false;
    optionDeleteConfirmOpen.value = false;
  },
  { immediate: true },
);

watch(
  recipe,
  (next) => {
    if (props.open && !props.prompt) {
      savedDraft.value = normalizePromptBuilderRecipe(next);
    }
  },
  { deep: true },
);
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogScrollContent class="max-h-[min(90vh,860px)] gap-0 p-0 sm:max-w-3xl">
      <DialogHeader class="border-b px-6 pb-4 pt-6 pr-14">
        <div class="flex items-center gap-2">
          <span class="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
            <SparklesIcon class="size-4" />
          </span>
          <div>
            <DialogTitle>{{ t('promptBuilder.title') }}</DialogTitle>
            <DialogDescription>{{ t('promptBuilder.description') }}</DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div
        class="grid gap-6 px-6 py-5"
        :inert="busy"
        :aria-busy="busy"
      >
        <section class="grid gap-2.5">
          <div>
            <h3 class="text-sm font-semibold">{{ t('promptBuilder.directionTitle') }}</h3>
            <p class="text-xs text-muted-foreground">{{ t('promptBuilder.directionDescription') }}</p>
          </div>
          <div class="grid gap-2 sm:grid-cols-3">
            <button
              v-for="scope in scopes"
              :key="scope.id"
              type="button"
              class="relative grid min-h-28 content-start gap-1 rounded-lg border p-3 text-left outline-none transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/40"
              :class="recipe.scope === scope.id ? 'border-primary bg-primary/5' : ''"
              :aria-pressed="recipe.scope === scope.id"
              @click="setScope(scope.id)"
            >
              <span class="flex items-center justify-between gap-2">
                <span class="text-sm font-semibold">{{ scope.label }}</span>
                <span
                  class="grid size-4 shrink-0 place-items-center rounded-full border"
                  :class="recipe.scope === scope.id ? 'border-primary bg-primary text-primary-foreground' : ''"
                >
                  <CheckIcon v-if="recipe.scope === scope.id" class="size-3" />
                </span>
              </span>
              <span class="text-xs leading-relaxed text-muted-foreground">{{ scope.description }}</span>
            </button>
          </div>
        </section>

        <section
          v-for="category in builderCategories"
          :key="category.id"
          class="grid gap-2.5"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <h3 class="text-sm font-semibold">{{ category.title }}</h3>
              <p class="text-xs text-muted-foreground">
                {{ t('promptBuilder.modifiersDescription') }}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-create-builder-option
              :aria-label="category.createLabel"
              @click="customOptionDialog?.openCreateOption(category.id)"
            >
              <PlusIcon class="size-3.5" />
              {{ t('promptBuilder.createOption') }}
            </Button>
          </div>

          <div class="grid gap-2 sm:grid-cols-2">
            <button
              v-for="option in category.builtIns"
              :key="option.id"
              type="button"
              class="flex min-h-20 items-start gap-3 rounded-lg border p-3 text-left outline-none transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/40"
              :class="selectedBuiltInSet.has(option.id) ? 'border-primary bg-primary/5' : ''"
              :aria-pressed="selectedBuiltInSet.has(option.id)"
              @click="toggleBuiltIn(option.id)"
            >
              <span
                class="mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border"
                :class="
                  selectedBuiltInSet.has(option.id)
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input'
                "
                aria-hidden="true"
              >
                <CheckIcon v-if="selectedBuiltInSet.has(option.id)" class="size-3" />
              </span>
              <span class="grid gap-0.5">
                <span class="text-sm font-semibold">{{ option.label }}</span>
                <span class="text-xs leading-relaxed text-muted-foreground">
                  {{ option.description }}
                </span>
              </span>
            </button>

            <div
              v-for="option in category.customOptions"
              :key="option.id"
              :data-builder-option="option.id"
              class="relative flex min-h-20 rounded-lg border transition-colors hover:border-primary/50 hover:bg-muted/40"
              :class="selectedCustomMap.has(option.id) ? 'border-primary bg-primary/5' : ''"
            >
              <button
                type="button"
                class="flex min-w-0 flex-1 items-start gap-3 rounded-lg p-3 pr-11 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                :aria-pressed="selectedCustomMap.has(option.id)"
                @click="toggleCustomOption(option)"
              >
                <span
                  class="mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border"
                  :class="
                    selectedCustomMap.has(option.id)
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input'
                  "
                  aria-hidden="true"
                >
                  <CheckIcon v-if="selectedCustomMap.has(option.id)" class="size-3" />
                </span>
                <span class="grid min-w-0 gap-0.5">
                  <span class="flex flex-wrap items-center gap-1.5">
                    <span class="text-sm font-semibold">
                      {{ displayedCustomOption(option).label }}
                    </span>
                    <Badge variant="secondary" class="px-1.5 py-0 text-[10px]">
                      {{ t('promptBuilder.customOption') }}
                    </Badge>
                    <Badge
                      v-if="customOptionHasSnapshotDrift(option)"
                      variant="outline"
                      class="px-1.5 py-0 text-[10px]"
                    >
                      {{ t('promptBuilder.savedOption') }}
                    </Badge>
                  </span>
                  <span class="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                    {{
                      displayedCustomOption(option).description ||
                      displayedCustomOption(option).instruction
                    }}
                  </span>
                </span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                :data-edit-builder-option="option.id"
                class="absolute right-2 top-2"
                :aria-label="t('promptBuilder.editOption', { label: option.label })"
                @click="customOptionDialog?.openEditOption(option)"
              >
                <PencilIcon class="size-3.5" />
              </Button>
            </div>
          </div>
        </section>

        <section
          v-if="orphanedCustomOptions.length"
          class="grid gap-2.5 rounded-lg border border-dashed p-3"
        >
          <div>
            <h3 class="text-sm font-semibold">{{ t('promptBuilder.savedOptionsTitle') }}</h3>
            <p class="text-xs text-muted-foreground">
              {{ t('promptBuilder.savedOptionsDescription') }}
            </p>
          </div>
          <div class="grid gap-2 sm:grid-cols-2">
            <button
              v-for="option in orphanedCustomOptions"
              :key="option.id"
              type="button"
              class="flex min-h-20 items-start gap-3 rounded-lg border border-primary bg-primary/5 p-3 text-left outline-none transition-colors hover:border-primary/70 focus-visible:ring-2 focus-visible:ring-ring/40"
              :aria-pressed="true"
              @click="removeSavedOption(option.id)"
            >
              <span
                class="mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border border-primary bg-primary text-primary-foreground"
                aria-hidden="true"
              >
                <CheckIcon class="size-3" />
              </span>
              <span class="grid min-w-0 gap-0.5">
                <span class="flex flex-wrap items-center gap-1.5">
                  <span class="text-sm font-semibold">{{ option.label }}</span>
                  <Badge variant="secondary" class="px-1.5 py-0 text-[10px]">
                    {{ t('promptBuilder.savedOption') }}
                  </Badge>
                </span>
                <span class="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {{ option.description || option.instruction }}
                </span>
              </span>
            </button>
          </div>
        </section>

        <section class="grid gap-3 rounded-lg border bg-muted/25 p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="grid gap-1.5">
              <h3 class="text-sm font-semibold">{{ t('promptBuilder.combinationTitle') }}</h3>
              <div class="flex flex-wrap gap-1.5">
                <Badge variant="secondary">{{ selectedScope.label }}</Badge>
                <Badge v-for="option in selectedOptions" :key="option.id" variant="outline">
                  {{ option.label }}
                </Badge>
                <span v-if="!selectedOptions.length" class="text-xs text-muted-foreground">
                  {{ t('promptBuilder.noModifiers') }}
                </span>
              </div>
            </div>
            <Button type="button" variant="ghost" size="xs" @click="previewOpen = !previewOpen">
              <EyeIcon class="size-3.5" />
              {{ previewOpen ? t('promptBuilder.hidePrompt') : t('promptBuilder.previewPrompt') }}
            </Button>
          </div>

          <pre
            v-if="previewOpen"
            class="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-xs leading-relaxed text-muted-foreground"
          >{{ compiledPrompt }}</pre>

          <div class="grid gap-1.5">
            <Label for="prompt-builder-name">{{ t('promptBuilder.bookmarkName') }}</Label>
            <Input
              id="prompt-builder-name"
              v-model="bookmarkName"
              :placeholder="suggestedName"
              maxlength="100"
            />
            <p class="text-xs text-muted-foreground">{{ t('promptBuilder.bookmarkHint') }}</p>
          </div>
        </section>
      </div>

      <DialogFooter class="sticky bottom-0 border-t bg-background/95 px-6 py-4 backdrop-blur">
        <Button
          v-if="isEditing"
          type="button"
          variant="destructive"
          class="mr-auto"
          :disabled="busy"
          @click="deleteConfirmOpen = true"
        >
          <Trash2Icon class="size-4" />
          {{ t('promptBuilder.deleteBookmark') }}
        </Button>
        <Button type="button" variant="ghost" :disabled="busy" @click="close()">
          {{ t('promptBuilder.cancel') }}
        </Button>
        <Button type="button" variant="outline" :disabled="busy" @click="useOnce">
          <SparklesIcon class="size-4" />
          {{ t('promptBuilder.useOnce') }}
        </Button>
        <Button type="button" :disabled="busy" @click="bookmarkAndUse">
          <Loader2Icon v-if="saving" class="size-4 animate-spin" />
          <BookmarkIcon v-else class="size-4" />
          {{ isEditing ? t('promptBuilder.updateBookmark') : t('promptBuilder.bookmarkAndUse') }}
        </Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>

  <AlertDialog v-model:open="deleteConfirmOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {{ t('promptBuilder.deleteBookmarkTitle', { label: prompt?.label }) }}
        </AlertDialogTitle>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="deleting">{{ t('promptBuilder.cancel') }}</AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          :disabled="deleting"
          @click.prevent="confirmDeleteBookmark"
        >
          <Loader2Icon v-if="deleting" class="size-4 animate-spin" />
          {{ t('promptBuilder.delete') }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <CustomOptionDialog
    ref="customOptionDialog"
    v-model:recipe="recipe"
    v-model:option-dialog-open="optionDialogOpen"
    v-model:option-delete-confirm-open="optionDeleteConfirmOpen"
    :option-snapshot="optionSnapshot"
  />
</template>
