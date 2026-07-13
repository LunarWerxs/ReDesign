<script setup lang="ts">
import { ref, useTemplateRef } from 'vue';
import { Loader2Icon } from '@lucide/vue';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useControlStore } from '@/stores/control';
import { referenceUrl } from '@/lib/api';
import { t } from '@/i18n';
import InputTile from './InputTile.vue';

const store = useControlStore();

const fileInput = useTemplateRef<HTMLInputElement>('fileInput');
const dragOver = ref(false);
const uploading = ref(false);

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
  const files = [...(e.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file' && String(item.type || '').startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((f): f is File => !!f);
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
        <div class="grid gap-3 rounded-lg border border-dashed bg-muted/30 p-3">
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
            @paste="onPaste"
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

          <div
            v-if="store.references.length"
            class="grid gap-2.5"
            style="grid-template-columns: repeat(auto-fill, minmax(110px, 1fr))"
          >
            <InputTile
              v-for="r in store.references"
              :key="r.id"
              :name="r.name"
              :src="referenceUrl(r.preview)"
              :selected="store.selReference.includes(r.id)"
              @toggle="store.toggleReference(r.id)"
            />
          </div>
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
</template>
