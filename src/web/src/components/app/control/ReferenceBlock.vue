<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useControlStore } from '@/stores/control';
import { clipboardImageFiles } from '@/composables/useImageUpload';
import { referenceUrl } from '@/lib/api';
import { t } from '@/i18n';
import ImageDropTarget from './ImageDropTarget.vue';
import InputTile from './InputTile.vue';
import PasteMenu from './PasteMenu.vue';

const store = useControlStore();

const pasteMenu = useTemplateRef<InstanceType<typeof PasteMenu>>('pasteMenu');
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
  }
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
      <!-- The `reference/` chips are <code>, not <span class="font-mono">: it is a literal
           directory name, which is what <code> is for, and i18n-check.mjs's SKIP_TEXT_TAGS
           already exempts <code>, so each one drops the i18n-ignore marker it used to need.
           Preflight gives <code> the mono family at font-size:1em, so nothing renders differently.
           The third chip now lives in ImageDropTarget, which renders it for both zones. -->
      <span class="text-xs text-muted-foreground"
        >, {{ t('reference.styleDirectionFrom') }}
        <code class="font-mono">reference/</code></span
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
          <ImageDropTarget
            dense
            :aria-label="t('reference.addImages')"
            :uploading="uploading"
            :label="uploading ? t('reference.addingImage') : t('reference.pasteOrDropImages')"
            :hint="t('reference.clickToBrowseHint')"
            folder="reference/"
            :hint-suffix="t('reference.andSelected')"
            @files="handle"
          />

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
            <code class="font-mono">reference/</code>.
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
