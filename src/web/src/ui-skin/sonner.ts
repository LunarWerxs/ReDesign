// The toaster's look in this app: components/ui/sonner reads its icons and colours through the @ui-skin alias.
export {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from "@lucide/vue"

export const toasterClass = "toaster"

// vue-sonner's CSS variables, set on the toaster so its toasts take the app's popover and border colours.
export const toasterStyle = {
  '--normal-bg': 'var(--popover)',
  '--normal-text': 'var(--popover-foreground)',
  '--normal-border': 'var(--border)',
  '--border-radius': 'var(--radius)',
  '--gray2': 'var(--muted)',
  '--gray3': 'var(--border)',
  '--gray4': 'var(--border)',
  '--gray5': 'var(--border)',
  '--gray12': 'var(--popover-foreground)',
}
