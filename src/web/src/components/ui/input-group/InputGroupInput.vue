<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/input-group"
import { Input } from "../input"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <Input
    data-slot="input-group-control"
    :class="cn(
      'rounded-none border-0 shadow-none ring-0 focus-visible:ring-0 aria-invalid:ring-0 flex-1',
      skin.control,
      props.class,
    )"
  />
</template>
