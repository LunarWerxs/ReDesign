// The command palette's look in this app: components/ui/command reads it through the @ui-skin alias and keeps the layout itself.
export { CheckIcon, SearchIcon } from "@lucide/vue"

export const surface = "bg-popover text-popover-foreground"
export const empty = "text-xs/relaxed"
export const group = "text-foreground **:[[cmdk-group-heading]]:text-muted-foreground **:[[cmdk-group-heading]]:text-xs"
export const input = "bg-input/20 dark:bg-input/30"
export const inputText = "text-xs/relaxed"
export const item = "data-highlighted:bg-muted data-highlighted:text-foreground data-highlighted:*:[svg]:text-foreground text-xs/relaxed"
export const separator = "bg-border/50"
export const shortcut = "text-muted-foreground group-data-selected/command-item:text-foreground text-3xs"

/** The words the palette says by default, in this app's language. */
export function useLabels() {
  return { title: "Command Palette", description: "Search for a command to run..." }
}
