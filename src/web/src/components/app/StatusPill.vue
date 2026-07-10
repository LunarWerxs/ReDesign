<script setup lang="ts">
import { Loader2Icon } from '@lucide/vue';

defineProps<{ live?: boolean; text?: string }>();
</script>

<template>
  <span
    class="inline-flex min-h-[30px] max-w-[min(48vw,560px)] items-center gap-1.5 truncate rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground"
  >
    <Loader2Icon v-if="live" class="size-3 shrink-0 animate-spin" />
    <slot>{{ text }}</slot>
  </span>
</template>
