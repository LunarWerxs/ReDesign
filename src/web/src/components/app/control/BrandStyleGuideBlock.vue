<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue';
import { FileTextIcon, Loader2Icon, XIcon } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import { clipboardTextFiles, textAttachableFiles } from '@/composables/useTextAttachments';

const store = useControlStore();

const fileInput = useTemplateRef<HTMLInputElement>('fileInput');
const dragOver = ref(false);
const uploading = ref(false);

const hasDefault = computed(() => !!store.brandStyleGuideDefault.trim());

async function handle(files: FileList | File[] | null) {
  uploading.value = true;
  try {
    await store.addBrandAttachments(files);
  } finally {
    uploading.value = false;
    dragOver.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.value?.click();
  }
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  e.stopPropagation();
  handle(e.dataTransfer?.files ?? null);
}

function onPaste(e: ClipboardEvent) {
  const files = clipboardTextFiles(e.clipboardData);
  if (!files.length) return;
  e.preventDefault();
  handle(files);
}

function onPickFiltered() {
  const input = fileInput.value;
  if (!input || !input.files) return;
  const accepted = textAttachableFiles(input.files);
  handle(accepted.length ? accepted : input.files).finally(() => {
    input.value = '';
  });
}

function loadDefault() {
  store.brandStyleGuide = store.brandStyleGuideDefault;
}
</script>

<template>
  <div class="grid gap-2.5">
    <Textarea
      v-model="store.brandStyleGuide"
      :placeholder="t('options.brandStyleGuidePlaceholder')"
    />

    <div class="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" @click="store.saveBrandStyleGuideDefault()">
        {{ t('options.brandStyleGuideSaveDefault') }}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        :disabled="!hasDefault"
        @click="loadDefault"
      >
        {{ t('options.brandStyleGuideLoadDefault') }}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        :disabled="!hasDefault"
        @click="store.clearBrandStyleGuideDefault()"
      >
        {{ t('options.brandStyleGuideClearDefault') }}
      </Button>
      <span class="text-xs text-muted-foreground">
        {{ hasDefault ? t('options.brandStyleGuideHasDefault') : t('options.brandStyleGuideNoDefault') }}
      </span>
    </div>

    <div class="grid gap-2">
      <div
        role="button"
        tabindex="0"
        :aria-label="t('options.brandAttachmentsAddFiles')"
        class="grid min-h-[56px] cursor-pointer place-items-center gap-0.5 rounded-lg border border-dashed bg-muted/30 p-3 text-center transition-colors outline-none focus-visible:border-primary"
        :class="[
          dragOver ? 'border-primary bg-accent' : 'border-input hover:border-primary',
          uploading ? 'pointer-events-none opacity-75' : '',
        ]"
        @click="fileInput?.click()"
        @keydown="onKeydown"
        @dragenter.prevent.stop="dragOver = true"
        @dragover.prevent.stop="dragOver = true"
        @dragleave="dragOver = false"
        @drop="onDrop"
        @paste="onPaste"
      >
        <input
          ref="fileInput"
          type="file"
          accept=".txt,.md,.markdown,.mdx,.csv,.json,.yaml,.yml,.xml,.html,.htm,text/*"
          multiple
          class="hidden"
          @change="onPickFiltered"
        />
        <div class="flex items-center gap-2 text-sm font-medium">
          <Loader2Icon v-if="uploading" class="size-4 animate-spin" />
          {{ uploading ? t('options.brandAttachmentsAdding') : t('options.brandAttachmentsPasteOrDrop') }}
        </div>
        <div class="text-xs text-muted-foreground">{{ t('options.brandAttachmentsClickToBrowse') }}</div>
      </div>

      <div v-if="store.brandAttachments.length" class="flex flex-wrap gap-1.5">
        <span
          v-for="a in store.brandAttachments"
          :key="a.id"
          class="flex max-w-full items-center gap-1.5 rounded-full border bg-muted/40 py-1 pl-2.5 pr-1 text-xs"
        >
          <FileTextIcon class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate" :title="a.name">{{ a.name }}</span>
          <Tooltip>
            <TooltipTrigger as-child>
              <button
                type="button"
                :aria-label="t('options.removeAttachment')"
                class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
                @click="store.removeBrandAttachment(a.id)"
              >
                <XIcon class="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{{ t('options.removeAttachment') }}</TooltipContent>
          </Tooltip>
        </span>
      </div>
    </div>
  </div>
</template>
