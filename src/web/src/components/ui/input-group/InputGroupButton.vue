<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import { inputGroupButtonVariants } from "@ui-skin/input-group"
import { Button, type ButtonVariants } from "../button"

const props = withDefaults(defineProps<{
  variant?: ButtonVariants["variant"]
  size?: "xs" | "sm" | "icon-xs" | "icon-sm"
  class?: HTMLAttributes["class"]
}>(), {
  size: "xs",
  variant: "ghost",
})
</script>

<template>
  <Button
    type="button"
    :data-size="props.size"
    :variant="props.variant"
    :class="cn(inputGroupButtonVariants({ size: props.size }), props.class)"
  >
    <slot />
  </Button>
</template>
