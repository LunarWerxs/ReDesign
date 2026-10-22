<script lang="ts">
import * as skin from "@ui-skin/popover"
import { cn } from "@ui-skin/cn"
import { defineSlotBox } from "../core/slot-box"

export default defineSlotBox("popover-header", cn("flex flex-col gap-1", skin.header))
</script>
