<script lang="ts" setup>
import type { ToasterProps } from "vue-sonner"
import { Toaster as Sonner } from "vue-sonner"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "@ui-skin/cn"
import * as skin from "@ui-skin/sonner"

// vue-sonner defaults its close button to the toast's TOP-LEFT corner, where it reads as a
// stray control floating beside the card rather than that card's dismiss. Every other dismiss
// in the kit sits top-right (DialogScrollContent, SheetContent), so match them. Still a
// default, not a hard-code: a consumer can pass close-button-position to move it back.
const props = withDefaults(defineProps<ToasterProps>(), { closeButtonPosition: "top-right" })
// `class` and `toastOptions` are set explicitly below, so omit them from the
// forwarded spread to avoid binding them twice (TS2783).
const forwarded = reactiveOmit(props, "class", "toastOptions")
</script>

<template>
  <Sonner
    :class="cn(skin.toasterClass, 'group', props.class)"
    :style="skin.toasterStyle"
    :toast-options="props.toastOptions ?? { classes: { toast: 'rounded-md' } }"
    v-bind="forwarded"
  >
    <template #success-icon>
      <skin.CircleCheckIcon class="size-4" />
    </template>
    <template #info-icon>
      <skin.InfoIcon class="size-4" />
    </template>
    <template #warning-icon>
      <skin.TriangleAlertIcon class="size-4" />
    </template>
    <template #error-icon>
      <skin.OctagonXIcon class="size-4" />
    </template>
    <template #loading-icon>
      <div>
        <skin.Loader2Icon class="size-4 animate-spin" />
      </div>
    </template>
    <template #close-icon>
      <skin.XIcon class="size-4" />
    </template>
  </Sonner>
</template>
