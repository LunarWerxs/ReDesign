import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

// Joins adjacent buttons into one control (split buttons: an action plus its caret menu).
// The `_[data-slot=button]` twins reach a Button that sits one wrapper down, e.g. inside the
// <span> a Tooltip needs so a disabled button still shows its hint.
export const buttonGroupVariants = cva(
  'flex w-fit items-stretch *:focus-visible:relative *:focus-visible:z-10 has-[>[data-slot=button-group]]:gap-2',
  {
    variants: {
      orientation: {
        horizontal: '[&>*:not(:first-child)]:rounded-s-none [&>*:not(:last-child)]:rounded-e-none [&>*:not(:first-child)_[data-slot=button]]:rounded-s-none [&>*:not(:last-child)_[data-slot=button]]:rounded-e-none',
        vertical: 'flex-col [&>*:not(:first-child)]:rounded-t-none [&>*:not(:last-child)]:rounded-b-none [&>*:not(:first-child)_[data-slot=button]]:rounded-t-none [&>*:not(:last-child)_[data-slot=button]]:rounded-b-none',
      },
      divider: {
        none: '',
        shade: '[&>*:not(:first-child)]:border-s-black/15 dark:[&>*:not(:first-child)]:border-s-white/20',
        "on-primary": '[&>*:not(:first-child)]:border-s-primary-foreground/25',
      },
    },
    defaultVariants: {
      orientation: "horizontal",
      divider: "none",
    },
  },
)
export type ButtonGroupVariants = VariantProps<typeof buttonGroupVariants>
