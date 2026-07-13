<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue';
import { onClickOutside } from '@vueuse/core';
import {
  ChevronDownIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  StarIcon,
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import PromptRow from './PromptRow.vue';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import type { Prompt } from '@/types';

const store = useControlStore();
const popoverOpen = ref(false);
const dialogOpen = ref(false);
const actionsOpen = ref(false);
const actionsMenuRef = useTemplateRef<HTMLElement>('actionsMenuRef');
const saving = ref(false);

const search = ref('');
// Prompts are few and ungrouped, so the "All prompts" drawer starts open (unlike
// the models picker, where the many-provider list collapses under the starred tier).
const showAll = ref(true);

const q = computed(() => search.value.trim().toLowerCase());

function matches(p: Prompt) {
  if (!q.value) return true;
  return (
    p.label.toLowerCase().includes(q.value) ||
    (p.description || '').toLowerCase().includes(q.value) ||
    (p.user || '').toLowerCase().includes(q.value)
  );
}

const filtered = computed(() => store.prompts.filter(matches));
const starred = computed(() => filtered.value.filter((p) => p.starred));
const rest = computed(() => filtered.value.filter((p) => !p.starred));
const anyStarredConfigured = computed(() => store.prompts.some((p) => p.starred));
// A search forces the drawer open so matches aren't hidden behind it.
const restOpen = computed(() => showAll.value || !!q.value);

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

// Delete now lives inside the edit dialog (one fewer icon per row). Close the
// editor, then hand off to the same confirm flow the row trash used to trigger.
function deleteFromDialog() {
  if (!form.value.id) return;
  const prompt: Prompt = {
    id: form.value.id,
    label: form.value.label,
    description: form.value.description,
    user: form.value.user,
  };
  dialogOpen.value = false;
  deletePrompt(prompt);
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
    <PopoverContent align="start" :collision-padding="12" class="w-[min(520px,calc(100vw-2rem))] p-2">
      <div class="flex items-center gap-2 px-1 pb-1">
        <strong class="text-xs uppercase tracking-wider text-muted-foreground">{{ t('promptSelect.prompts') }}</strong>
        <div class="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="xs" @click="store.selectAll('prompts')">{{ t('promptSelect.all') }}</Button>
          <Button variant="ghost" size="xs" @click="store.selectNone('prompts')">{{ t('promptSelect.none') }}</Button>
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

      <div class="px-1 pb-1.5">
        <div class="relative">
          <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="search" :placeholder="t('promptSelect.searchPlaceholder')" class="h-8 pl-8" />
        </div>
      </div>

      <div class="grid max-h-[min(50vh,380px)] grid-cols-1 gap-0.5 overflow-y-auto overflow-x-hidden pr-1">
        <p v-if="!filtered.length" class="px-1 py-3 text-center text-xs text-muted-foreground">
          {{ t('promptSelect.noMatches') }}
        </p>

        <!-- Starred tier -->
        <template v-if="starred.length || (anyStarredConfigured && !q)">
          <div class="flex items-center gap-1.5 px-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <StarIcon class="size-3 fill-current text-amber-400" />
            {{ t('promptSelect.starred') }}
          </div>
          <PromptRow v-for="p in starred" :key="p.id" :prompt="p" @edit="openEdit" />
          <p v-if="!starred.length" class="px-1 pb-1 text-xs text-muted-foreground">{{ t('promptSelect.starredEmpty') }}</p>
        </template>

        <!-- All prompts drawer -->
        <template v-if="rest.length">
          <button
            type="button"
            class="mt-0.5 flex items-center gap-1.5 rounded-md px-1 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground outline-none hover:text-foreground"
            @click="showAll = !showAll"
          >
            <ChevronDownIcon class="size-3.5 transition-transform" :class="restOpen ? 'rotate-0' : '-rotate-90'" />
            {{ t('promptSelect.allPrompts') }}
            <span class="text-muted-foreground/70">({{ rest.length }})</span>
          </button>
          <div v-show="restOpen" class="grid grid-cols-1 gap-0.5">
            <PromptRow v-for="p in rest" :key="p.id" :prompt="p" @edit="openEdit" />
          </div>
        </template>
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
        <div class="flex items-center justify-end gap-2">
          <Button
            v-if="form.id"
            type="button"
            variant="destructive"
            class="mr-auto"
            @click="deleteFromDialog"
          >
            <Trash2Icon class="size-4" />
            {{ t('promptSelect.deletePrompt') }}
          </Button>
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
