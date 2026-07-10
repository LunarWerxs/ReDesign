<script setup lang="ts">
import { ExternalLinkIcon } from '@lucide/vue';
import { inputUrl } from '@/lib/api';
import type { InputItem } from '@/types';
import { t } from '@/i18n';

const props = defineProps<{ input: InputItem }>();

const images = () => (props.input.images && props.input.images.length ? props.input.images : [props.input.preview]);
</script>

<template>
  <div class="flex flex-col overflow-hidden rounded-lg border bg-card">
    <div class="flex items-center gap-2.5 border-b px-3 py-2.5">
      <span class="size-2.5 shrink-0 rounded-full bg-white" />
      <span class="text-[13px] font-bold">{{ t('viewer.original') }}</span>
      <span v-if="input.type === 'group'" class="text-xs text-muted-foreground">{{ t('viewer.refsCount', { count: input.imageCount ?? 0 }, input.imageCount ?? 0) }}</span>
      <span class="flex-1" />
      <a :href="inputUrl(input.preview)" target="_blank" class="text-muted-foreground hover:text-foreground" :title="t('viewer.open')">
        <ExternalLinkIcon class="size-3.5" />
      </a>
    </div>
    <div class="max-h-[700px] overflow-auto bg-black">
      <img v-for="(rel, i) in images()" :key="i" loading="lazy" :src="inputUrl(rel)" alt="" class="block w-full" />
    </div>
  </div>
</template>
