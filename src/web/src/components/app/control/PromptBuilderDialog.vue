<script setup lang="ts">
import { computed, ref, watch } from 'vue';
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
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
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
import type {
  Prompt,
  PromptBuilderCustomOptionSnapshot,
  PromptBuilderModifierId,
  PromptBuilderOption,
  PromptBuilderOptionCategory,
  PromptBuilderOptionSaveRequest,
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
const optionSaving = ref(false);
const optionDeleting = ref(false);
const optionForm = ref<PromptBuilderOptionSaveRequest>({
  label: '',
  description: '',
  instruction: '',
  category: 'structure',
});

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
const optionIsEditing = computed(() => !!optionForm.value.id);
const optionFormValid = computed(
  () => !!optionForm.value.label.trim() && !!optionForm.value.instruction.trim(),
);
const optionBusy = computed(() => optionSaving.value || optionDeleting.value);
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

function openCreateOption(category: PromptBuilderOptionCategory) {
  optionForm.value = {
    label: '',
    description: '',
    instruction: '',
    category,
  };
  optionDialogOpen.value = true;
}

function openEditOption(option: PromptBuilderOption) {
  optionForm.value = {
    id: option.id,
    label: option.label,
    description: option.description ?? '',
    instruction: option.instruction,
    category: option.category,
  };
  optionDialogOpen.value = true;
}

function onOptionDialogOpenChange(open: boolean) {
  if (!open && optionBusy.value) return;
  optionDialogOpen.value = open;
}

async function saveOption() {
  if (!optionFormValid.value || optionBusy.value) return;
  const wasNew = !optionForm.value.id;
  optionSaving.value = true;
  try {
    const saved = await store.savePromptBuilderOption({
      ...optionForm.value,
      label: optionForm.value.label.trim(),
      description: optionForm.value.description?.trim() || undefined,
      instruction: optionForm.value.instruction.trim(),
    });
    if (!saved) return;

    const selected = selectedCustomOptions.value;
    const selectedIndex = selected.findIndex((option) => option.id === saved.id);
    const next =
      wasNew || selectedIndex >= 0
        ? [
            ...selected.filter((option) => option.id !== saved.id),
            optionSnapshot(saved),
          ]
        : selected;
    recipe.value = normalizePromptBuilderRecipe({ ...recipe.value, customOptions: next });
    optionDialogOpen.value = false;
  } finally {
    optionSaving.value = false;
  }
}

async function confirmDeleteOption() {
  const id = optionForm.value.id;
  if (!id || optionBusy.value) return;
  optionDeleting.value = true;
  try {
    if (!(await store.deletePromptBuilderOption(id))) return;
    removeSavedOption(id);
    optionDeleteConfirmOpen.value = false;
    optionDialogOpen.value = false;
  } finally {
    optionDeleting.value = false;
  }
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
              @click="openCreateOption(category.id)"
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
                @click="openEditOption(option)"
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

  <Dialog :open="optionDialogOpen" @update:open="onOptionDialogOpenChange">
    <DialogContent class="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {{
            optionIsEditing
              ? t('promptBuilder.editOptionTitle')
              : t('promptBuilder.createOptionTitle')
          }}
        </DialogTitle>
        <DialogDescription>{{ t('promptBuilder.optionDialogDescription') }}</DialogDescription>
      </DialogHeader>

      <form class="grid gap-4" :aria-busy="optionBusy" @submit.prevent="saveOption">
        <div class="grid gap-1.5">
          <Label for="prompt-builder-option-category">
            {{ t('promptBuilder.optionCategory') }}
          </Label>
          <Select v-model="optionForm.category" :disabled="optionBusy">
            <SelectTrigger id="prompt-builder-option-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="structure">
                {{ t('promptBuilder.optionCategoryStructure') }}
              </SelectItem>
              <SelectItem value="design">
                {{ t('promptBuilder.optionCategoryDesign') }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="grid gap-1.5">
          <Label for="prompt-builder-option-name">{{ t('promptBuilder.optionName') }}</Label>
          <Input
            id="prompt-builder-option-name"
            v-model="optionForm.label"
            :placeholder="t('promptBuilder.optionNamePlaceholder')"
            maxlength="100"
            :disabled="optionBusy"
            required
          />
        </div>

        <div class="grid gap-1.5">
          <Label for="prompt-builder-option-description">
            {{ t('promptBuilder.optionDescription') }}
          </Label>
          <Input
            id="prompt-builder-option-description"
            v-model="optionForm.description"
            :placeholder="t('promptBuilder.optionDescriptionPlaceholder')"
            maxlength="300"
            :disabled="optionBusy"
          />
        </div>

        <div class="grid gap-1.5">
          <Label for="prompt-builder-option-instruction">
            {{ t('promptBuilder.optionInstruction') }}
          </Label>
          <Textarea
            id="prompt-builder-option-instruction"
            v-model="optionForm.instruction"
            class="min-h-36"
            :placeholder="t('promptBuilder.optionInstructionPlaceholder')"
            maxlength="4000"
            :disabled="optionBusy"
            required
          />
          <p class="text-xs text-muted-foreground">
            {{ t('promptBuilder.optionInstructionHint') }}
          </p>
        </div>

        <div class="flex items-center justify-end gap-2">
          <Button
            v-if="optionIsEditing"
            type="button"
            variant="destructive"
            class="mr-auto"
            :disabled="optionBusy"
            @click="optionDeleteConfirmOpen = true"
          >
            <Trash2Icon class="size-4" />
            {{ t('promptBuilder.deleteOption') }}
          </Button>
          <Button
            type="button"
            variant="ghost"
            :disabled="optionBusy"
            @click="optionDialogOpen = false"
          >
            {{ t('promptBuilder.cancel') }}
          </Button>
          <Button type="submit" :disabled="optionBusy || !optionFormValid">
            <Loader2Icon v-if="optionSaving" class="size-4 animate-spin" />
            {{
              optionIsEditing
                ? t('promptBuilder.saveChanges')
                : t('promptBuilder.createAndSelect')
            }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>

  <AlertDialog v-model:open="optionDeleteConfirmOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {{ t('promptBuilder.deleteOptionTitle', { label: optionForm.label }) }}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {{ t('promptBuilder.deleteOptionDescription') }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="optionDeleting">
          {{ t('promptBuilder.cancel') }}
        </AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          :disabled="optionDeleting"
          @click.prevent="confirmDeleteOption"
        >
          <Loader2Icon v-if="optionDeleting" class="size-4 animate-spin" />
          {{ t('promptBuilder.deleteOption') }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
