<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/input-group"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="input-group"
    role="group"
    :class="cn(
      'h-7 rounded-md border transition-colors in-data-[slot=combobox-content]:focus-within:border-inherit in-data-[slot=combobox-content]:focus-within:ring-0 has-data-[align=block-end]:rounded-md has-data-[align=block-start]:rounded-md has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot][aria-invalid=true]]:ring-2 has-[textarea]:rounded-md has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-end]]:[&>input]:pt-3 has-[>[data-align=block-start]]:[&>input]:pb-3 has-[>[data-align=inline-end]]:[&>input]:pe-1.5 has-[>[data-align=inline-start]]:[&>input]:ps-1.5 group/input-group relative flex w-full min-w-0 items-center outline-none has-[>textarea]:h-auto',
      skin.group,
      props.class,
    )"
  >
    <slot />
  </div>
</template>
