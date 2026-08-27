<script setup lang="ts">
import type { InputGroupButtonProps } from "./input-group-variants"
import { cn } from "@/lib/utils"
import { Button } from '@/components/ui/button'
import { inputGroupButtonVariants } from "./input-group-variants"

const props = withDefaults(defineProps<InputGroupButtonProps>(), {
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
