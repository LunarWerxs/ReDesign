<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/input-group"
import { Textarea } from "../textarea"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <Textarea
    data-slot="input-group-control"
    :class="cn(
      'rounded-none border-0 py-2 shadow-none ring-0 focus-visible:ring-0 aria-invalid:ring-0 flex-1 resize-none',
      skin.control,
      props.class,
    )"
  />
</template>
