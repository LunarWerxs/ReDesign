<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ButtonGroupVariants } from "./button-group-variants"
import { cn } from "@/lib/utils"
import { buttonGroupVariants } from "./button-group-variants"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  orientation?: ButtonGroupVariants["orientation"]
  divider?: ButtonGroupVariants["divider"]
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
