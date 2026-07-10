<script setup lang="ts">
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useControlStore } from '@/stores/control';
import { referenceUrl } from '@/lib/api';
import { t } from '@/i18n';
import InputTile from './InputTile.vue';

const store = useControlStore();
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
            <span class="font-mono">reference/</span>. {{ t('reference.dropOneInHint') }}
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
