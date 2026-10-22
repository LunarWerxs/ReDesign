<script setup lang="ts">
import type { DialogRootEmits, DialogRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { useForwardPropsEmits } from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/command"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../dialog"
import Command from "./Command.vue"

const props = withDefaults(defineProps<DialogRootProps & {
  title?: string
  description?: string
  class?: HTMLAttributes["class"]
  showCloseButton?: boolean
}>(), {
  showCloseButton: false,
})
const emits = defineEmits<DialogRootEmits>()

// The title and description are read only by screen readers; the caller's props win over these defaults.
const labels = skin.useLabels()
const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <Dialog v-slot="slotProps" v-bind="forwarded">
    <DialogContent
      :class="cn('rounded-xl! top-1/3 translate-y-0 overflow-hidden p-0', props.class)"
      :show-close-button="showCloseButton"
    >
      <DialogHeader class="sr-only">
        <DialogTitle>{{ title ?? labels.title }}</DialogTitle>
        <DialogDescription>{{ description ?? labels.description }}</DialogDescription>
      </DialogHeader>
      <Command>
        <slot v-bind="slotProps" />
      </Command>
    </DialogContent>
  </Dialog>
</template>
