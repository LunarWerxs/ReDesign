<script setup lang="ts">
import { ref, useTemplateRef } from 'vue';
import { onClickOutside } from '@vueuse/core';
import {
  ChevronDownIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
  WandIcon,
} from '@lucide/vue';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import type { Prompt } from '@/types';

const store = useControlStore();
const popoverOpen = ref(false);
const dialogOpen = ref(false);
const actionsOpen = ref(false);
const actionsMenuRef = useTemplateRef<HTMLElement>('actionsMenuRef');
const saving = ref(false);

onClickOutside(actionsMenuRef, () => {
  actionsOpen.value = false;
});
const form = ref({
  id: '',
  label: '',
  description: '',
  user: '',
});

function openAdd() {
  actionsOpen.value = false;
  form.value = { id: '', label: '', description: '', user: '' };
  dialogOpen.value = true;
}

function openEdit(prompt: Prompt) {
  form.value = {
    id: prompt.id,
    label: prompt.label || '',
    description: prompt.description || '',
    user: prompt.user || '',
  };
  dialogOpen.value = true;
}

function onRowKeydown(e: KeyboardEvent, id: string) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  store.togglePrompt(id);
}

async function save() {
  saving.value = true;
  try {
    const saved = await store.savePrompt({
      id: form.value.id || undefined,
      label: form.value.label,
      description: form.value.description,
      user: form.value.user,
    });
    if (saved) dialogOpen.value = false;
  } finally {
    saving.value = false;
  }
}

const deletePromptConfirmOpen = ref(false);
const pendingDeletePrompt = ref<Prompt | null>(null);

function deletePrompt(prompt: Prompt) {
  pendingDeletePrompt.value = prompt;
  deletePromptConfirmOpen.value = true;
}

async function confirmDeletePrompt() {
  const prompt = pendingDeletePrompt.value;
  if (!prompt) return;
  await store.deletePrompt(prompt.id);
  pendingDeletePrompt.value = null;
}

const restoreDefaultsConfirmOpen = ref(false);

function restoreDefaults() {
  actionsOpen.value = false;
  restoreDefaultsConfirmOpen.value = true;
}

async function confirmRestoreDefaults() {
  await store.restoreDefaultPrompts();
}

function selectAll() {
  actionsOpen.value = false;
  store.selectAll('prompts');
}

function selectNone() {
  actionsOpen.value = false;
  store.selectNone('prompts');
}

function useCustom() {
  actionsOpen.value = false;
  popoverOpen.value = false;
  store.advancedOpen = true;
  store.customOn = true;
}
</script>

<template>
  <Popover v-model:open="popoverOpen">
    <PopoverTrigger as-child>
      <Button variant="outline" class="min-w-[150px] justify-between" :title="t('promptSelect.choosePromptsTitle')">

        <span>{{ t('promptSelect.prompts') }}</span>
        <span class="ml-auto text-muted-foreground"
          >{{ store.selPrompts.length }}/{{ store.prompts.length }}</span
        >
        <ChevronDownIcon class="size-4 text-muted-foreground" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" :collision-padding="12" class="w-[min(680px,calc(100vw-2rem))] p-2">
      <div class="flex items-center gap-2 px-1 pb-2">
        <strong class="text-xs uppercase tracking-wider text-muted-foreground">{{ t('promptSelect.prompts') }}</strong>
        <div class="relative ml-auto flex gap-1.5">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="ghost" size="icon-xs" :aria-label="t('promptSelect.addPrompt')" @click="openAdd">
                <PlusIcon class="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t('promptSelect.addPrompt') }}</TooltipContent>
          </Tooltip>
          <div ref="actionsMenuRef" class="relative">
            <Tooltip>
              <TooltipTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  :aria-label="t('promptSelect.promptActions')"
                  @click="actionsOpen = !actionsOpen"
                >
                  <MoreHorizontalIcon class="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{{ t('promptSelect.promptActions') }}</TooltipContent>
            </Tooltip>
            <div
              v-if="actionsOpen"
              class="cn-menu-translucent absolute right-0 top-full z-50 mt-1 grid w-44 gap-1 rounded-md bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
            >
              <button type="button" class="cursor-pointer select-none rounded-sm px-2 py-1.5 text-left hover:bg-accent" @click="selectAll">{{ t('promptSelect.all') }}</button>
              <button type="button" class="cursor-pointer select-none rounded-sm px-2 py-1.5 text-left hover:bg-accent" @click="selectNone">{{ t('promptSelect.none') }}</button>
              <div class="-mx-1 my-1 h-px bg-border" />
              <button type="button" class="flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent" @click="restoreDefaults">
                <RotateCcwIcon class="size-4" />
                {{ t('promptSelect.restoreDefaults') }}
              </button>
              <div class="-mx-1 my-1 h-px bg-border" />
              <button type="button" class="flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent" @click="useCustom">
                <WandIcon class="size-4" />
                {{ t('promptSelect.useCustom') }}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="grid max-h-[min(50vh,360px)] gap-1.5 overflow-y-auto pr-1">
          <div
            v-for="p in store.prompts"
            :key="p.id"
            role="button"
            tabindex="0"
            class="group/prompt flex cursor-pointer select-none items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors outline-none focus-visible:border-primary"
            :class="store.selPrompts.includes(p.id) ? 'border-primary bg-accent' : 'hover:border-muted-foreground/40'"
            @click="store.togglePrompt(p.id)"
            @keydown="onRowKeydown($event, p.id)"
          >
            <Checkbox class="pointer-events-none" :model-value="store.selPrompts.includes(p.id)" tabindex="-1" />
            <span class="flex-1">
              <span class="font-semibold">{{ p.label }}</span>
              <span v-if="p.description" class="text-xs text-muted-foreground"> · {{ p.description }}</span>
            </span>
            <Tooltip>
              <TooltipTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  :aria-label="t('promptSelect.editPrompt')"
                  class="opacity-0 transition-opacity group-hover/prompt:opacity-100 focus-visible:opacity-100"
                  @click.stop="openEdit(p)"
                >
                  <PencilIcon class="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{{ t('promptSelect.editPrompt') }}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  :aria-label="t('promptSelect.deletePrompt')"
                  class="text-destructive opacity-0 transition-opacity group-hover/prompt:opacity-100 focus-visible:opacity-100"
                  @click.stop="deletePrompt(p)"
                >
                  <Trash2Icon class="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{{ t('promptSelect.deletePrompt') }}</TooltipContent>
            </Tooltip>
          </div>
      </div>
    </PopoverContent>
  </Popover>

  <Dialog :open="dialogOpen" @update:open="dialogOpen = $event">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ form.id ? t('promptSelect.editPromptTitle') : t('promptSelect.addPromptTitle') }}</DialogTitle>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="save">
        <div class="grid gap-1.5">
          <Label for="prompt-label">{{ t('promptSelect.name') }}</Label>
          <Input
            id="prompt-label"
            v-model="form.label"
            :placeholder="t('promptSelect.namePlaceholder')"
            required
          />
        </div>
        <div class="grid gap-1.5">
          <Label for="prompt-description">{{ t('promptSelect.description') }}</Label>
          <Input
            id="prompt-description"
            v-model="form.description"
            :placeholder="t('promptSelect.descriptionPlaceholder')"
          />
        </div>
        <div class="grid gap-1.5">
          <Label for="prompt-user">{{ t('promptSelect.promptLabel') }}</Label>
          <Textarea
            id="prompt-user"
            v-model="form.user"
            class="min-h-44"
            :placeholder="t('promptSelect.promptPlaceholder')"
            required
          />
        </div>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" @click="dialogOpen = false">{{ t('promptSelect.cancel') }}</Button>
          <Button type="submit" :disabled="saving">
            <Loader2Icon v-if="saving" class="size-4 animate-spin" />
            {{ t('promptSelect.save') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>

  <AlertDialog v-model:open="deletePromptConfirmOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ t('promptSelect.deletePromptConfirmTitle', { label: pendingDeletePrompt?.label }) }}</AlertDialogTitle>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ t('promptSelect.cancel') }}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" @click="confirmDeletePrompt">{{ t('promptSelect.delete') }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <AlertDialog v-model:open="restoreDefaultsConfirmOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ t('promptSelect.restoreDefaultsConfirmTitle') }}</AlertDialogTitle>
        <AlertDialogDescription>{{ t('promptSelect.restoreDefaultsConfirmDescription') }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ t('promptSelect.cancel') }}</AlertDialogCancel>
        <AlertDialogAction @click="confirmRestoreDefaults">{{ t('promptSelect.restore') }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
