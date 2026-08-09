<script setup lang="ts">
/**
 * Create/edit sub-dialog for a reusable prompt-builder custom option, plus its own
 * delete-confirm. Extracted out of PromptBuilderDialog.vue, which owns the recipe and
 * merely hosts this dialog: it opens the form via the exposed openCreateOption /
 * openEditOption methods (see the `ref="customOptionDialog"` usage there) and reads
 * `optionBusy` back out so its own busy/inert state still covers an in-flight save or
 * delete here, exactly as before the split.
 */
import { computed, ref } from 'vue';
import { Loader2Icon, Trash2Icon } from '@lucide/vue';
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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { normalizePromptBuilderRecipe } from '@/lib/prompt-builder';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import type {
  PromptBuilderCustomOptionSnapshot,
  PromptBuilderOption,
  PromptBuilderOptionCategory,
  PromptBuilderOptionSaveRequest,
  PromptBuilderRecipe,
} from '@/types';

const props = defineProps<{
  // Same snapshot-builder the parent's own toggleCustomOption uses, passed in so a
  // reused option is stored identically whichever surface (this dialog's save, or the
  // grid's toggle button) selected it. Kept as a single definition in the parent rather
  // than duplicated here.
  optionSnapshot: (option: PromptBuilderOption) => PromptBuilderCustomOptionSnapshot;
}>();

// Two-way bound to the parent's active recipe: saving or deleting a custom option here
// also updates (or clears) its selection on the recipe, same as the parent used to do
// inline.
const recipe = defineModel<PromptBuilderRecipe>('recipe', { required: true });

// The dialog's own open state and its delete-confirm are also two-way bound so the
// parent can force both shut when it resets for a freshly opened/different prompt.
const optionDialogOpen = defineModel<boolean>('optionDialogOpen', { default: false });
const optionDeleteConfirmOpen = defineModel<boolean>('optionDeleteConfirmOpen', {
  default: false,
});

const store = useControlStore();

const optionSaving = ref(false);
const optionDeleting = ref(false);
const optionForm = ref<PromptBuilderOptionSaveRequest>({
  label: '',
  description: '',
  instruction: '',
  category: 'structure',
});

const optionIsEditing = computed(() => !!optionForm.value.id);
const optionFormValid = computed(
  () => !!optionForm.value.label.trim() && !!optionForm.value.instruction.trim(),
);
const optionBusy = computed(() => optionSaving.value || optionDeleting.value);

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

    const selected = recipe.value.customOptions ?? [];
    const selectedIndex = selected.findIndex((option) => option.id === saved.id);
    const next =
      wasNew || selectedIndex >= 0
        ? [...selected.filter((option) => option.id !== saved.id), props.optionSnapshot(saved)]
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
    recipe.value = normalizePromptBuilderRecipe({
      ...recipe.value,
      customOptions: (recipe.value.customOptions ?? []).filter((option) => option.id !== id),
    });
    optionDeleteConfirmOpen.value = false;
    optionDialogOpen.value = false;
  } finally {
    optionDeleting.value = false;
  }
}

// Imperative API for the parent's "create" and edit-pencil buttons, which need to seed
// this dialog's form before opening it; optionBusy is exposed too so the parent's own
// busy/inert computation still folds this dialog's in-flight save/delete in.
defineExpose({ openCreateOption, openEditOption, optionBusy });
</script>

<template>
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
