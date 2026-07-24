<script setup lang="ts">
/**
 * Right-click → "Paste" flyout for an image drop zone. Shared by the screenshot zone
 * (InputDropzone) and the reference zone (ReferenceBlock): the native context menu can't hand
 * a page an image off the clipboard, so each zone offers this one item and reads the clipboard
 * itself via navigator.clipboard.read().
 *
 * Usage: `<PasteMenu ref="pasteMenu" @paste="handle" />` plus `@contextmenu="pasteMenu?.openAt($event)"`
 * on the zone. Emits the decoded File[] (never empty); a blocked or image-free clipboard is
 * swallowed silently, exactly as a native paste with nothing to paste would be.
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { ClipboardPasteIcon } from '@lucide/vue';
import { t } from '@/i18n';

const emit = defineEmits<{ paste: [files: File[]] }>();

const open = ref(false);
const x = ref(0);
const y = ref(0);

function openAt(e: MouseEvent) {
  e.preventDefault();
  x.value = e.clientX;
  y.value = e.clientY;
  open.value = true;
}
function close() {
  open.value = false;
}

async function pasteFromClipboard() {
  close();
  try {
    const items = await navigator.clipboard.read();
    const files: File[] = [];
    for (const item of items) {
      const type = item.types.find((mime) => mime.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      files.push(new File([blob], `pasted-${Date.now()}.${type.split('/')[1] || 'png'}`, { type }));
    }
    if (files.length) emit('paste', files);
  } catch {
    /* clipboard read blocked or empty, ignore */
  }
}

function onEscape(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}

onMounted(() => window.addEventListener('keydown', onEscape));
onUnmounted(() => window.removeEventListener('keydown', onEscape));

defineExpose({ openAt, close });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[60]"
      @pointerdown="close"
      @contextmenu.prevent="close"
      @wheel="close"
    >
      <div
        class="animate-in fade-in-0 zoom-in-95 fixed z-[61] min-w-[8.5rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md duration-150"
        :style="{ left: `${x}px`, top: `${y}px` }"
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
