<script setup lang="ts">
import { ref, useTemplateRef, watch } from 'vue';
import { Loader2Icon } from '@lucide/vue';

/**
 * The one image drop target, behind both zones that have one: the screenshot dropzone
 * (InputDropzone) and the reference zone inside ReferenceBlock. Those two carried a
 * line-for-line copy of the same click / Enter-Space / drag / drop / hidden-file-input
 * wiring and differed only in size, wording, and which store action ran — the shape that
 * drifts apart the first time one of them is fixed and the other is forgotten. It already
 * had: the reference chip became a <code> here while its twin stayed a <span>.
 *
 * It owns `dragOver` and the file input. It deliberately does NOT own `uploading`: both
 * parents also upload through paths this element never sees — a right-click Paste from
 * PasteMenu, and InputDropzone's document-level paste listener — so the busy flag has to
 * live beside those, and arrives here as a prop.
 */
const props = defineProps<{
  /** Busy state, owned by the parent because paste uploads bypass this element entirely. */
  uploading: boolean;
  /** The bold line. The parent swaps in its own "adding…" wording while uploading. */
  label: string;
  /** Small print before the folder chip. */
  hint: string;
  /** Literal folder name, rendered as <code>. Not `dir`: that is a real HTML attribute. */
  folder: string;
  /** Small print after the folder chip. */
  hintSuffix: string;
  /** The reference zone's tighter sizing; the screenshot zone is the roomier default. */
  dense?: boolean;
}>();

const emit = defineEmits<{ files: [files: File[], source: 'browse' | 'drop'] }>();

const fileInput = useTemplateRef<HTMLInputElement>('fileInput');
const dragOver = ref(false);

// The highlight outlives the drop: both zones kept it lit for the length of the upload and
// dropped it when the upload settled, which is what this reproduces now that the parents no
// longer hold `dragOver` themselves. Watching the flag down (rather than clearing on drop)
// also covers an upload that fails, the case the old `finally` blocks were there for.
watch(
  () => props.uploading,
  (busy) => {
    if (!busy) dragOver.value = false;
  },
);

function onPick() {
  const input = fileInput.value;
  if (!input) return;
  // Snapshot before the reset: `input.files` is live, and clearing it is what makes picking
  // the SAME file a second time fire `change` again.
  const files = [...(input.files ?? [])];
  input.value = '';
  emit('files', files, 'browse');
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
  emit('files', [...(e.dataTransfer?.files ?? [])], 'drop');
}
</script>

<template>
  <div
    role="button"
    tabindex="0"
    class="grid cursor-pointer place-items-center gap-0.5 rounded-lg border border-dashed bg-muted/30 text-center transition-colors outline-none focus-visible:border-primary"
    :class="[
      dense ? 'min-h-[64px] p-3' : 'min-h-[86px] p-4',
      dragOver ? 'border-primary bg-accent' : 'border-input hover:border-primary',
      uploading ? 'pointer-events-none opacity-75' : '',
    ]"
    @click="fileInput?.click()"
    @keydown="onKeydown"
    @dragenter.prevent.stop="dragOver = true"
    @dragover.prevent.stop="dragOver = true"
    @dragleave="dragOver = false"
    @drop="onDrop"
  >
    <!-- @click.stop, because the whole tile is itself a click target that calls this input's
         click(): without it the synthetic click bubbles straight back to the tile and opens the
         picker again, forever. Real browsers happen to mask that with the spec's "click in
         progress" flag, so the loop only shows up off-browser — happy-dom blew the stack on it. -->
    <input
      ref="fileInput"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
      multiple
      class="hidden"
      @click.stop
      @change="onPick"
    />
    <div class="flex items-center gap-2" :class="dense ? 'text-sm font-medium' : 'font-bold'">
      <Loader2Icon v-if="uploading" class="size-4 animate-spin" />
      {{ label }}
    </div>
    <div class="text-xs text-muted-foreground">
      {{ hint }}
      <code class="font-mono">{{ folder }}</code> {{ hintSuffix }}
    </div>
  </div>
</template>
