<script lang="ts">
import * as skin from "@ui-skin/popover"
import { cn } from "@ui-skin/cn"
import { defineSlotBox } from "../core/slot-box"

export default defineSlotBox("popover-title", cn("font-medium cn-font-heading", skin.title))
</script>
