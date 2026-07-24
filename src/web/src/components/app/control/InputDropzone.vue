<script setup lang="ts">
import { onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import { Loader2Icon } from '@lucide/vue';
import { useControlStore } from '@/stores/control';
import { clipboardImageFiles, uploadableImageFiles } from '@/composables/useImageUpload';
import { t } from '@/i18n';
import PasteMenu from './PasteMenu.vue';

const store = useControlStore();
const fileInput = useTemplateRef<HTMLInputElement>('fileInput');
const pasteMenu = useTemplateRef<InstanceType<typeof PasteMenu>>('pasteMenu');
const dragOver = ref(false);
const uploading = ref(false);

async function handle(files: FileList | File[] | null, source: string) {
  uploading.value = true;
  try {
    await store.uploadFiles(files, source);
  } finally {
    uploading.value = false;
    dragOver.value = false;
  }
}

function onPick() {
  const input = fileInput.value;
  if (!input) return;
  handle(input.files, 'browse').finally(() => {
    input.value = '';
  });
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
  handle(e.dataTransfer?.files ?? null, 'drop');
}

// Document-level paste + drop so screenshots can be dropped/pasted anywhere.
function onDocDragOver(e: DragEvent) {
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
}
function onDocDrop(e: DragEvent) {
  const inZone = e.target instanceof Element && e.target.closest('[data-input-drop]');
  if (!inZone && uploadableImageFiles(e.dataTransfer?.files).length) e.preventDefault();
}
function onPaste(e: ClipboardEvent) {
  // The reference zone stops its own paste from bubbling this far, but a paste aimed at a
  // descendant of it (a tile, the note textarea) still reaches the document. Screenshots are
  // the fallback target for a paste aimed at NOTHING in particular, never for one aimed at
  // another drop zone — pasting one image into both lists at once is never what was meant.
  if (e.target instanceof Element && e.target.closest('[data-reference-drop]')) return;
  const files = clipboardImageFiles(e.clipboardData);
  if (!files.length) return;
  e.preventDefault();
  handle(files, 'paste');
}

onMounted(() => {
  document.addEventListener('dragover', onDocDragOver);
  document.addEventListener('drop', onDocDrop);
  document.addEventListener('paste', onPaste);
});
onUnmounted(() => {
  document.removeEventListener('dragover', onDocDragOver);
  document.removeEventListener('drop', onDocDrop);
  document.removeEventListener('paste', onPaste);
});
</script>

<template>
  <div
    data-input-drop
    role="button"
    tabindex="0"
    :aria-label="t('input.addScreenshots')"
    class="mb-3 grid min-h-[86px] cursor-pointer place-items-center gap-0.5 rounded-lg border border-dashed bg-muted/30 p-4 text-center transition-colors outline-none focus-visible:border-primary"
    :class="[
      dragOver ? 'border-primary bg-accent' : 'border-input hover:border-primary',
      uploading ? 'pointer-events-none opacity-75' : '',
    ]"
    @click="fileInput?.click()"
    @keydown="onKeydown"
    @contextmenu="pasteMenu?.openAt($event)"
    @dragenter.prevent.stop="dragOver = true"
    @dragover.prevent.stop="dragOver = true"
    @dragleave="dragOver = false"
    @drop="onDrop"
  >
    <input
      ref="fileInput"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
      multiple
      class="hidden"
      @change="onPick"
    />
    <div class="flex items-center gap-2 font-bold">
      <Loader2Icon v-if="uploading" class="size-4 animate-spin" />
      {{ uploading ? t('input.addingScreenshot') : t('input.pasteOrDropScreenshots') }}
    </div>
    <div class="text-xs text-muted-foreground">
      {{ t('input.clickToBrowseHint') }}
      <!-- i18n-ignore -->
      <span class="font-mono">input/</span> {{ t('input.andSelected') }}
    </div>
  </div>

  <PasteMenu ref="pasteMenu" @paste="(files) => handle(files, 'paste')" />
</template>
