<script setup lang="ts">
import type { ListboxGroupProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ListboxGroup, ListboxGroupLabel, useId } from "reka-ui"
import { computed, onMounted, onUnmounted } from "vue"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/command"
import { provideCommandGroupContext, useCommand } from "./command-context"

const props = defineProps<ListboxGroupProps & {
  class?: HTMLAttributes["class"]
  heading?: string
}>()

const delegatedProps = reactiveOmit(props, "class")

const { allGroups, filterState } = useCommand()
const id = useId()

const isRender = computed(() => !filterState.search ? true : filterState.filtered.groups.has(id))

provideCommandGroupContext({ id })
onMounted(() => {
  if (!allGroups.value.has(id))
    allGroups.value.set(id, new Set())
})
onUnmounted(() => {
  allGroups.value.delete(id)
})
</script>

<template>
  <ListboxGroup
    v-bind="delegatedProps"
    :id="id"
    data-slot="command-group"
    :class="cn('overflow-hidden p-1 **:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:font-medium', skin.group, props.class)"
    :hidden="isRender ? undefined : true"
  >
    <ListboxGroupLabel v-if="heading" data-slot="command-group-heading" class="">
      {{ heading }}
    </ListboxGroupLabel>
    <slot />
  </ListboxGroup>
</template>
