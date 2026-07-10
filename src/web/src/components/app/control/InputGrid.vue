<script setup lang="ts">
import { computed, ref } from 'vue';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import RunControls from './RunControls.vue';
import {
  Dialog,
  DialogContent,
  DialogHeader,
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
    <CardHeader class="flex flex-row items-center gap-2.5">
      <CardTitle class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {{ t('input.inputsTitle') }}
      </CardTitle>
      <div class="ml-auto flex gap-2">
        <Button variant="ghost" size="sm" @click="store.selectAll('inputs')">{{ t('input.all') }}</Button>
        <Button variant="ghost" size="sm" @click="store.selectNone('inputs')">{{ t('input.none') }}</Button>
      </div>
    </CardHeader>
    <CardContent>
      <InputDropzone />

      <div
        v-if="sessionInputs.length"
        class="grid gap-2.5"
        style="grid-template-columns: repeat(auto-fill, minmax(150px, 1fr))"
      >
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
        <div class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('input.previousSessions') }}
          <span class="ml-1 font-normal text-muted-foreground/70">{{ previousInputs.length }}</span>
        </div>
        <div
          class="grid gap-2"
          style="grid-template-columns: repeat(auto-fill, minmax(104px, 124px))"
        >
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
    <CardFooter>
      <RunControls />
    </CardFooter>
  </Card>

  <Dialog :open="!!previewInput" @update:open="onPreviewOpenChange">
    <DialogContent class="max-h-[94vh] w-[min(98vw,1500px)] max-w-none gap-0 overflow-hidden p-0">
      <DialogHeader class="border-b px-4 py-3">
        <DialogTitle class="truncate pr-10 text-sm">{{ previewInput?.name }}</DialogTitle>
      </DialogHeader>
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
