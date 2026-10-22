<script setup lang="ts">
import type { AlertDialogContentEmits, AlertDialogContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  AlertDialogContent,
  AlertDialogOverlay,
  AlertDialogPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/alert-dialog"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  defineProps<AlertDialogContentProps & {
    class?: HTMLAttributes["class"]
    size?: "default" | "sm"
  }>(),
  {
    size: "default",
  },
)
const emits = defineEmits<AlertDialogContentEmits>()

const delegatedProps = reactiveOmit(props, "class", "size")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <AlertDialogPortal>
    <AlertDialogOverlay
      data-slot="alert-dialog-overlay"
      :class="cn('data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-100 fixed inset-0 z-50', skin.overlay)"
    />
    <AlertDialogContent
      data-slot="alert-dialog-content"
      :data-size="size"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="
        cn(
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 gap-3 rounded-xl p-4 ring-1 duration-100 data-[size=default]:max-w-xs data-[size=sm]:max-w-64 data-[size=default]:sm:max-w-sm group/alert-dialog-content fixed top-1/2 left-[calc(50%-var(--content-inset-right,0px)/2)] z-50 grid w-full -translate-1/2 outline-none',
          skin.content,
          props.class,
        )
      "
    >
      <slot />
    </AlertDialogContent>
  </AlertDialogPortal>
</template>
