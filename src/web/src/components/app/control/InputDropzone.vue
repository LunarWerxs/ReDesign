<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import { useControlStore } from '@/stores/control';
import { clipboardImageFiles, uploadableImageFiles } from '@/composables/useImageUpload';
import { t } from '@/i18n';
import ImageDropTarget from './ImageDropTarget.vue';
import PasteMenu from './PasteMenu.vue';

const store = useControlStore();
const pasteMenu = useTemplateRef<InstanceType<typeof PasteMenu>>('pasteMenu');
const uploadsInFlight = ref(0);
const uploading = computed(() => uploadsInFlight.value > 0);

async function handle(files: FileList | File[] | null, source: string) {
  uploadsInFlight.value += 1;
  try {
    await store.uploadFiles(files, source);
  } finally {
    uploadsInFlight.value -= 1;
  }
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
  if (uploading.value) {
    e.preventDefault();
    return;
  }
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
  <!-- data-input-drop and the spacing fall through to ImageDropTarget's root, which is the
       element onDocDrop looks for with closest(). -->
  <ImageDropTarget
    data-input-drop
    class="mb-3"
    :aria-label="t('input.addScreenshots')"
    :uploading="uploading"
    :label="uploading ? t('input.addingScreenshot') : t('input.pasteOrDropScreenshots')"
    :hint="t('input.clickToBrowseHint')"
    folder="input/"
    :hint-suffix="t('input.andSelected')"
    @contextmenu="pasteMenu?.openAt($event)"
    @files="handle"
  />

  <PasteMenu ref="pasteMenu" @paste="(files) => handle(files, 'paste')" />
</template>
