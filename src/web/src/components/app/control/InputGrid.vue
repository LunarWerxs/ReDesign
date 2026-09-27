<script setup lang="ts">
import { computed, ref } from 'vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { useControlStore } from '@/stores/control';
import { inputUrl } from '@/lib/api';
import type { InputItem } from '@/types';
import { t } from '@/i18n';
import InputDropzone from './InputDropzone.vue';
import InputTile from './InputTile.vue';

const store = useControlStore();
const previewInput = ref<InputItem | null>(null);

const sessionInputSet = computed(() => new Set(store.sessionInputIds));
const sessionInputs = computed(() => store.inputs.filter((it) => sessionInputSet.value.has(it.id)));
const previousInputs = computed(() => store.inputs.filter((it) => !sessionInputSet.value.has(it.id)));

function badge(it: InputItem) {
  return it.type === 'group' ? t('input.imgsCount', { count: it.imageCount }) : t('input.image');
}

function openPreview(it: InputItem) {
  previewInput.value = it;
}

function onPreviewOpenChange(open: boolean) {
  if (!open) previewInput.value = null;
}
</script>

<template>
  <Card>
    <CardHeader class="flex flex-row items-center">
      <CardTitle>
        <span class="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('input.inputsTitle') }}
        </span>
      </CardTitle>
    </CardHeader>
    <CardContent>
      <InputDropzone />

      <div v-if="sessionInputs.length" class="input-tile-grid grid gap-2.5">
        <InputTile
          v-for="it in sessionInputs"
          :key="it.id"
          :name="it.name"
          :src="inputUrl(it.preview)"
          :badge="badge(it)"
          :selected="store.selInputs.includes(it.id)"
          previewable
          removable
          @toggle="store.toggleInput(it.id)"
          @remove="store.deleteInput(it.id)"
          @preview="openPreview(it)"
        />
      </div>

      <div v-if="previousInputs.length" class="mt-4 grid gap-2.5">
        <div class="flex items-center gap-2.5">
          <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {{ t('input.previousSessions') }}
            <span class="ms-1 font-normal text-muted-foreground/70">{{ previousInputs.length }}</span>
          </div>
          <div class="ms-auto flex gap-2">
            <Button variant="ghost" size="sm" @click="store.selectAll('inputs')">{{ t('input.all') }}</Button>
            <Button variant="ghost" size="sm" @click="store.selectNone('inputs')">{{ t('input.none') }}</Button>
          </div>
        </div>
        <div class="input-tile-grid-compact grid gap-2">
          <InputTile
            v-for="it in previousInputs"
            :key="it.id"
            :name="it.name"
            :src="inputUrl(it.preview)"
            :badge="badge(it)"
            :selected="store.selInputs.includes(it.id)"
            size="compact"
            previewable
            removable
            @toggle="store.toggleInput(it.id)"
            @remove="store.deleteInput(it.id)"
            @preview="openPreview(it)"
          />
        </div>
      </div>

      <p v-if="!store.inputs.length" class="text-xs text-muted-foreground">{{ t('input.noImagesFound') }}</p>
    </CardContent>
  </Card>

  <Dialog :open="!!previewInput" @update:open="onPreviewOpenChange">
    <DialogContent flush class="max-h-[94vh] w-[min(98vw,1500px)] max-w-none overflow-hidden">
      <!-- plain wrapper, not DialogHeader: this flush header draws its own rule and padding, and
           pe-14 (px-4 + the old pe-10) keeps the title clear of the close button -->
      <div class="border-b py-3 ps-4 pe-14">
        <DialogTitle><span class="block truncate">{{ previewInput?.name }}</span></DialogTitle>
      </div>
      <div class="max-h-[calc(94vh-49px)] overflow-auto bg-black p-3">
        <img
          v-if="previewInput"
          :src="inputUrl(previewInput.preview)"
          :alt="previewInput.name"
          class="mx-auto block h-auto w-full max-w-none rounded-sm"
        />
      </div>
    </DialogContent>
  </Dialog>
</template>
