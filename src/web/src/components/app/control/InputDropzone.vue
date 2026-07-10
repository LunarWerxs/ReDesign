<script setup lang="ts">
import { onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import { ClipboardPasteIcon, Loader2Icon } from '@lucide/vue';
import { useControlStore } from '@/stores/control';
import { clipboardImageFiles, uploadableImageFiles } from '@/composables/useImageUpload';
import { t } from '@/i18n';

const store = useControlStore();
const fileInput = useTemplateRef<HTMLInputElement>('fileInput');
const dragOver = ref(false);
const uploading = ref(false);

// Right-click → "Paste" flyout.
const menuOpen = ref(false);
const menuX = ref(0);
const menuY = ref(0);

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

// ── right-click → Paste flyout ────────────────────────────────────────────────
function openMenu(e: MouseEvent) {
  e.preventDefault();
  menuX.value = e.clientX;
  menuY.value = e.clientY;
  menuOpen.value = true;
}
function closeMenu() {
  menuOpen.value = false;
}
async function pasteFromClipboard() {
  closeMenu();
  try {
    const items = await navigator.clipboard.read();
    const files: File[] = [];
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      files.push(new File([blob], `pasted-${Date.now()}.${type.split('/')[1] || 'png'}`, { type }));
    }
    if (files.length) await handle(files, 'paste');
  } catch {
    /* clipboard read blocked or empty, ignore */
  }
}
function onEscape(e: KeyboardEvent) {
  if (e.key === 'Escape') closeMenu();
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
  const files = clipboardImageFiles(e.clipboardData);
  if (!files.length) return;
  e.preventDefault();
  handle(files, 'paste');
}

onMounted(() => {
  document.addEventListener('dragover', onDocDragOver);
  document.addEventListener('drop', onDocDrop);
  document.addEventListener('paste', onPaste);
  window.addEventListener('keydown', onEscape);
});
onUnmounted(() => {
  document.removeEventListener('dragover', onDocDragOver);
  document.removeEventListener('drop', onDocDrop);
  document.removeEventListener('paste', onPaste);
  window.removeEventListener('keydown', onEscape);
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
    @contextmenu="openMenu"
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

  <!-- custom right-click flyout -->
  <Teleport to="body">
    <div
      v-if="menuOpen"
      class="fixed inset-0 z-[60]"
      @pointerdown="closeMenu"
      @contextmenu.prevent="closeMenu"
      @wheel="closeMenu"
    >
      <div
        class="animate-in fade-in-0 zoom-in-95 fixed z-[61] min-w-[8.5rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md duration-150"
        :style="{ left: `${menuX}px`, top: `${menuY}px` }"
        @pointerdown.stop
      >
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
          @click="pasteFromClipboard"
        >
          <ClipboardPasteIcon class="size-4" /> {{ t('input.paste') }}
        </button>
      </div>
    </div>
  </Teleport>
</template>
