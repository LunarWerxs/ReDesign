<script setup lang="ts">
import type { PopoverContentEmits, PopoverContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  PopoverContent,
  PopoverPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/popover"
import { usePortalTo } from "../core/portal-to"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  defineProps<PopoverContentProps & { class?: HTMLAttributes["class"], flush?: boolean }>(),
  {
    align: "center",
    sideOffset: 4,
  },
)
const emits = defineEmits<PopoverContentEmits>()

const delegatedProps = reactiveOmit(props, "class", "flush")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
// Where the overlay portals to: the body, or the root an ancestor provides (portal-to.ts).
const portalTo = usePortalTo()
</script>

<template>
  <PopoverPortal :to="portalTo">
    <PopoverContent
      data-slot="popover-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :data-flush="flush ? '' : undefined"
      :class="
        cn(
          skin.content,
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 flex flex-col gap-4 rounded-lg p-2.5 shadow-md ring-1 duration-100 z-50 w-72 origin-(--reka-popover-content-transform-origin) outline-hidden',
          flush && 'gap-0 p-0',
          props.class,
        )
      "
    >
      <slot />
    </PopoverContent>
  </PopoverPortal>
</template>
