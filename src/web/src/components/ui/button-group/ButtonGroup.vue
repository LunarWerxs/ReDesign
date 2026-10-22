<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import { buttonGroupVariants } from "@ui-skin/button-group"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  orientation?: "horizontal" | "vertical"
  divider?: "none" | "shade" | "on-primary"
}>()
</script>

<template>
  <div
    role="group"
    data-slot="button-group"
    :data-orientation="orientation ?? 'horizontal'"
    :class="cn(buttonGroupVariants({ orientation, divider }), props.class)"
  >
    <slot />
  </div>
</template>
