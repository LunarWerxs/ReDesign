<script setup lang="ts">
import type { ProgressRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  ProgressIndicator,
  ProgressRoot,
} from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/progress"

const props = withDefaults(
  defineProps<ProgressRootProps & { class?: HTMLAttributes["class"] }>(),
  {
    modelValue: 0,
  },
)

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <ProgressRoot
    data-slot="progress"
    v-bind="delegatedProps"
    :class="
      cn(
        'h-1 rounded-md relative flex w-full items-center overflow-x-hidden',
        skin.track,
        props.class,
      )
    "
  >
    <ProgressIndicator
      data-slot="progress-indicator"
      :class="cn('size-full flex-1 translate-x-(--progress-translate) transition-transform', skin.indicator)"
      :style="{ '--progress-translate': `-${100 - (props.modelValue ?? 0)}%` }"
    />
  </ProgressRoot>
</template>
