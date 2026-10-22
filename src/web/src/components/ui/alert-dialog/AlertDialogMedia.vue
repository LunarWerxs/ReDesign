<script lang="ts">
import * as skin from "@ui-skin/alert-dialog"
import { cn } from "@ui-skin/cn"
import { defineSlotBox } from "../core/slot-box"

export default defineSlotBox("alert-dialog-media", cn("mb-2 inline-flex size-8 items-center justify-center rounded-md sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*=size-])]:size-4", skin.media))
</script>
