<script setup lang="ts">
import type { ListboxFilterProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ListboxFilter, useForwardProps } from "reka-ui"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/command"
import { InputGroup, InputGroupAddon } from "../input-group"
import { useCommand } from "./command-context"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<ListboxFilterProps & {
  class?: HTMLAttributes["class"]
}>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)

const { filterState } = useCommand()
</script>

<template>
  <div
    data-slot="command-input-wrapper"
    class="p-1 pb-0"
  >
    <InputGroup :class="cn('h-8!', skin.input)">
      <ListboxFilter
        v-bind="{ ...forwardedProps, ...$attrs }"
        v-model="filterState.search"
        data-slot="command-input"
        auto-focus
        :class="cn('w-full outline-hidden disabled:cursor-not-allowed disabled:opacity-50', skin.inputText, props.class)"
      />
      <InputGroupAddon>
        <skin.SearchIcon class="size-3.5 shrink-0 opacity-50" />
      </InputGroupAddon>
    </InputGroup>
  </div>
</template>
