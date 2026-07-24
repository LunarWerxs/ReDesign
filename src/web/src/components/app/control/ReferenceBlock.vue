<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue';
import { Loader2Icon } from '@lucide/vue';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useControlStore } from '@/stores/control';
import { clipboardImageFiles } from '@/composables/useImageUpload';
import { referenceUrl } from '@/lib/api';
import { t } from '@/i18n';
import InputTile from './InputTile.vue';
import PasteMenu from './PasteMenu.vue';

const store = useControlStore();

const fileInput = useTemplateRef<HTMLInputElement>('fileInput');
const pasteMenu = useTemplateRef<InstanceType<typeof PasteMenu>>('pasteMenu');
const dragOver = ref(false);
const uploading = ref(false);

// Every TICKED reference goes to the models, uncapped (there is no "max images" stepper any
// more), so the ticked/total count is the honest readout of what a run will actually send.
const selectedCount = computed(
  () => store.references.filter((r) => store.selReference.includes(r.id)).length,
);
const allSelected = computed(
  () => store.references.length > 0 && selectedCount.value === store.references.length,
);

async function handle(files: FileList | File[] | null) {
  uploading.value = true;
  try {
    await store.uploadReferences(files);
  } finally {
    uploading.value = false;
    dragOver.value = false;
  }
}

function onPick() {
  const input = fileInput.value;
  if (!input) return;
  handle(input.files).finally(() => {
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
  handle(e.dataTransfer?.files ?? null);
}

function onPaste(e: ClipboardEvent) {
  // stopPropagation, not just preventDefault: InputDropzone listens for `paste` on the
  // DOCUMENT so a screenshot can be pasted anywhere on the page. Without this the one
  // Ctrl+V landed in BOTH lists — once here as a reference, once there as a screenshot.
  e.stopPropagation();
  const files = clipboardImageFiles(e.clipboardData);
  if (!files.length) return;
  e.preventDefault();
  handle(files);
}
</script>

<template>
  <div class="grid gap-2.5">
    <div class="flex items-center gap-2">
      <Switch id="ref-toggle" v-model="store.referenceOn" />
      <Label for="ref-toggle">{{ t('reference.useReferenceImage') }}</Label>
      <span class="text-xs text-muted-foreground"
        >, {{ t('reference.styleDirectionFrom') }}
        <!-- i18n-ignore -->
        <span class="font-mono">reference/</span></span
      >
    </div>

    <div
      class="grid transition-[grid-template-rows] duration-300 ease-out"
      :style="{ gridTemplateRows: store.referenceOn ? '1fr' : '0fr' }"
      :aria-hidden="!store.referenceOn"
      :inert="!store.referenceOn"
    >
      <div class="overflow-hidden">
        <!-- data-reference-drop + the paste handler sit on the WHOLE panel, not just the drop
             target: an image pasted anywhere in here (over a tile, from the note field) is a
             reference, and InputDropzone's document-level listener stands down for it. -->
        <div
          data-reference-drop
          class="grid gap-3 rounded-lg border border-dashed bg-muted/30 p-3"
          @paste="onPaste"
          @contextmenu="pasteMenu?.openAt($event)"
        >
          <div
            role="button"
            tabindex="0"
            :aria-label="t('reference.addImages')"
            class="grid min-h-[64px] cursor-pointer place-items-center gap-0.5 rounded-lg border border-dashed bg-muted/30 p-3 text-center transition-colors outline-none focus-visible:border-primary"
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
          >
            <input
              ref="fileInput"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
              multiple
              class="hidden"
              @change="onPick"
            />
            <div class="flex items-center gap-2 text-sm font-medium">
              <Loader2Icon v-if="uploading" class="size-4 animate-spin" />
              {{ uploading ? t('reference.addingImage') : t('reference.pasteOrDropImages') }}
            </div>
            <div class="text-xs text-muted-foreground">
              {{ t('reference.clickToBrowseHint') }}
              <!-- i18n-ignore -->
              <span class="font-mono">reference/</span> {{ t('reference.andSelected') }}
            </div>
          </div>

          <template v-if="store.references.length">
            <div class="flex items-center gap-2">
              <span class="text-xs text-muted-foreground">
                {{ t('reference.selectedCount', { selected: selectedCount, total: store.references.length }) }}
              </span>
              <div class="ml-auto flex gap-1.5">
                <Button
                  variant="ghost"
                  size="xs"
                  :disabled="allSelected"
                  @click="store.selectAll('reference')"
                >
                  {{ t('reference.selectAll') }}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  :disabled="!selectedCount"
                  @click="store.selectNone('reference')"
                >
                  {{ t('reference.selectNone') }}
                </Button>
              </div>
            </div>

            <div class="grid gap-2.5" style="grid-template-columns: repeat(auto-fill, minmax(110px, 1fr))">
              <InputTile
                v-for="r in store.references"
                :key="r.id"
                :name="r.name"
                :src="referenceUrl(r.preview)"
                :selected="store.selReference.includes(r.id)"
                @toggle="store.toggleReference(r.id)"
              />
            </div>
          </template>
          <p v-else class="text-xs text-muted-foreground">
            {{ t('reference.noImagesIn') }}
            <!-- i18n-ignore -->
            <span class="font-mono">reference/</span>.
          </p>
          <div class="grid gap-1.5">
            <Label class="text-xs text-muted-foreground">{{ t('reference.noteLabel') }}</Label>
            <Textarea
              v-model="store.refNote"
              class="min-h-[56px]"
              :placeholder="t('reference.notePlaceholder')"
            />
          </div>
        </div>
      </div>
    </div>
  </div>

  <PasteMenu ref="pasteMenu" @paste="handle" />
</template>
