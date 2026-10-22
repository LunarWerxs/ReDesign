<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/input-group"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <span
    :class="cn(
      'gap-2 [&_svg:not([class*=size-])]:size-4 flex items-center [&_svg]:pointer-events-none',
      skin.text,
      props.class,
    )"
  >
    <slot />
  </span>
</template>
