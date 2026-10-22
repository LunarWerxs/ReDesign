<script setup lang="ts">
import type { AlertDialogActionProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { AlertDialogAction } from "reka-ui"
import { cn } from "@ui-skin/cn"
import { buttonVariants } from "../button"

// The variant and size names are the app's own (the button's skin); the button's index types them for callers.
const props = withDefaults(
  defineProps<AlertDialogActionProps & {
    class?: HTMLAttributes["class"]
    variant?: string | null
    size?: string | null
  }>(),
  {
    variant: "default",
    size: "default",
  },
)

const delegatedProps = reactiveOmit(props, "class", "variant", "size")
</script>

<template>
  <AlertDialogAction
    data-slot="alert-dialog-action"
    v-bind="delegatedProps"
    :class="cn(buttonVariants({ variant, size } as never), props.class)"
  >
    <slot />
  </AlertDialogAction>
</template>
