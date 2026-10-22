<script setup lang="ts">
import type { CheckboxRootEmits, CheckboxRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { CheckboxIndicator, CheckboxRoot, useForwardPropsEmits } from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/checkbox"

const props = defineProps<CheckboxRootProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<CheckboxRootEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <CheckboxRoot
    v-slot="slotProps"
    data-slot="checkbox"
    v-bind="forwarded"
    :class="cn('flex size-4 items-center justify-center rounded-sm border group-has-disabled/field:opacity-50 focus-visible:ring-2 aria-invalid:ring-2 peer relative shrink-0 outline-none after:absolute after:-inset-x-3 after:-inset-y-2 disabled:cursor-not-allowed disabled:opacity-50', skin.box, props.class)"
  >
    <CheckboxIndicator
      data-slot="checkbox-indicator"
      class="[&>svg]:size-3.5 grid place-content-center text-current transition-none"
    >
      <slot v-bind="slotProps">
        <skin.CheckIcon />
      </slot>
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
