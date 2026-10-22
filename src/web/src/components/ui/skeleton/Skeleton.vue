<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/skeleton"
import { skeletonVariants } from "./skeleton-variants"

// line and width are the skeleton-variants table's names, typed here as literal unions.
interface SkeletonProps {
  class?: HTMLAttributes["class"]
  shape?: "default" | "bubble"
  line?: "none" | "dot" | "text" | "title" | "chip" | "button" | null
  width?: "none" | "8" | "10" | "12" | "14" | "16" | "20" | "24" | "28" | "32" | null
}

const props = defineProps<SkeletonProps>()
</script>

<template>
  <div
    data-slot="skeleton"
    :data-shape="shape"
    :class="cn('rounded-md animate-pulse', skin.surface, shape === 'bubble' && 'rounded-2xl', skeletonVariants({ line, width }), props.class)"
  />
</template>
