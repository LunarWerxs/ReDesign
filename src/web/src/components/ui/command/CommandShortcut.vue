<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/command"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <span
    data-slot="command-shortcut"
    :class="cn('ms-auto tracking-widest', skin.shortcut, props.class)"
  >
    <slot />
  </span>
</template>
