<script setup lang="ts">
import { ExternalLinkIcon } from '@lucide/vue';
import { inputUrl, outputRawUrl } from '@/lib/api';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { InputItem } from '@/types';
import { t } from '@/i18n';

const props = defineProps<{ input: InputItem; runId: string; specVersion?: number }>();

const images = () => (props.input.images && props.input.images.length ? props.input.images : [props.input.preview]);
const assetUrl = (rel: string) =>
  props.specVersion === 1 ? outputRawUrl(`${props.runId}/${rel}`) : inputUrl(rel);
</script>

<template>
  <div class="flex flex-col overflow-hidden rounded-lg border bg-card">
    <div class="flex items-center gap-2.5 border-b px-3 py-2.5">
      <span class="size-2.5 shrink-0 rounded-full bg-white" />
      <span class="text-[13px] font-bold">{{ t('viewer.original') }}</span>
      <span v-if="input.type === 'group'" class="text-xs text-muted-foreground">{{ t('viewer.refsCount', { count: input.imageCount ?? 0 }, input.imageCount ?? 0) }}</span>
      <span class="flex-1" />
      <Tooltip>
        <TooltipTrigger as-child>
          <a
            :href="assetUrl(input.preview)"
            target="_blank"
            :aria-label="t('viewer.open')"
            class="text-muted-foreground hover:text-foreground"
          >
            <ExternalLinkIcon class="size-3.5" />
          </a>
        </TooltipTrigger>
        <TooltipContent>{{ t('viewer.open') }}</TooltipContent>
      </Tooltip>
    </div>
    <div class="max-h-[700px] overflow-auto bg-black">
      <img v-for="(rel, i) in images()" :key="i" loading="lazy" :src="assetUrl(rel)" alt="" class="block w-full" />
    </div>
  </div>
</template>
