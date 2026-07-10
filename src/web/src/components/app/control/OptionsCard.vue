<script setup lang="ts">
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useControlStore } from '@/stores/control';
import { t } from '@/i18n';
import ModelMultiSelect from './ModelMultiSelect.vue';
import PromptMultiSelect from './PromptMultiSelect.vue';
import ReferenceBlock from './ReferenceBlock.vue';

const store = useControlStore();

function clampVariants(v: unknown) {
  store.variants = Math.max(1, Math.min(10, Number(v) || 1));
}
function clampMaxImages(v: unknown) {
  store.maxImages = Math.max(1, Math.min(16, Number(v) || 8));
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {{ t('options.title') }}
      </CardTitle>
    </CardHeader>
    <CardContent class="grid gap-3.5">
      <div class="flex flex-wrap items-center gap-3">
        <ModelMultiSelect />
        <PromptMultiSelect />
        <div class="flex items-center gap-2" :title="t('options.advancedDescription')">
          <Switch id="advanced-options" v-model="store.advancedOpen" />
          <Label for="advanced-options" class="cursor-pointer">{{ t('options.advanced') }}</Label>
        </div>
      </div>

      <div
        class="grid transition-[grid-template-rows] duration-300 ease-out"
        :style="{ gridTemplateRows: store.advancedOpen ? '1fr' : '0fr' }"
        :aria-hidden="!store.advancedOpen"
        :inert="!store.advancedOpen"
      >
        <div class="overflow-hidden">
          <div class="grid gap-3 rounded-lg border border-dashed bg-muted/30 p-3">
            <div class="flex flex-wrap items-center gap-3">
              <div class="flex items-center gap-2" :title="t('options.variantsDescription')">
                <Label class="text-muted-foreground">{{ t('options.variants') }}</Label>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  class="w-16"
                  :model-value="store.variants"
                  @update:model-value="clampVariants"
                />
              </div>
              <div class="flex items-center gap-2" :title="t('options.maxImagesDescription')">
                <Label class="text-muted-foreground">{{ t('options.maxImages') }}</Label>
                <Input
                  type="number"
                  min="1"
                  max="16"
                  class="w-16"
                  :model-value="store.maxImages"
                  @update:model-value="clampMaxImages"
                />
              </div>
              <div class="flex items-center gap-2" :title="t('options.mockDescription')">
                <Switch id="mock" v-model="store.mock" />
                <Label for="mock" class="cursor-pointer">{{ t('options.mock') }}</Label>
              </div>
              <div class="flex items-center gap-2" :title="t('options.customPromptDescription')">
                <Switch id="custom-prompt" v-model="store.customOn" />
                <Label for="custom-prompt" class="cursor-pointer">{{ t('options.customPrompt') }}</Label>
              </div>
            </div>

            <div
              class="grid transition-[grid-template-rows] duration-300 ease-out"
              :style="{ gridTemplateRows: store.customOn ? '1fr' : '0fr' }"
              :aria-hidden="!store.customOn"
              :inert="!store.customOn"
            >
              <div class="overflow-hidden">
                <Textarea
                  v-model="store.custom"
                  :placeholder="t('options.customPlaceholder')"
                />
              </div>
            </div>

            <ReferenceBlock />
          </div>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
