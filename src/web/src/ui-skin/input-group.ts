// The input group's look in this app: components/ui/input-group reads it through the @ui-skin alias and keeps the layout itself.

import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"
import type { HTMLAttributes } from "vue"

export const group = "border-input bg-input/20 dark:bg-input/30 has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-ring/30 has-[[data-slot][aria-invalid=true]]:ring-destructive/20 has-[[data-slot][aria-invalid=true]]:border-destructive dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40"
export const control = "bg-transparent dark:bg-transparent"
export const text = "text-muted-foreground text-xs/relaxed"

export const inputGroupAddonVariants = cva(
  'text-muted-foreground **:data-[slot=kbd]:bg-muted-foreground/10 h-auto gap-1 py-2 text-xs/relaxed font-medium group-data-[disabled=true]/input-group:opacity-50 **:data-[slot=kbd]:rounded-[calc(var(--radius-sm)-2px)] **:data-[slot=kbd]:px-1 **:data-[slot=kbd]:text-3xs [&>svg:not([class*=size-])]:size-3.5 flex cursor-text items-center justify-center select-none',
  {
    variants: {
      align: {
        "inline-start": 'pl-2 has-[>button]:ml-[-0.275rem] has-[>kbd]:ml-[-0.275rem] order-first',
        "inline-end": 'pr-2 has-[>button]:mr-[-0.275rem] has-[>kbd]:mr-[-0.275rem] order-last',
        "block-start": 'px-2 pt-2 group-has-[>input]/input-group:pt-2 [.border-b]:pb-2 order-first w-full justify-start',
        "block-end": 'px-2 pb-2 group-has-[>input]/input-group:pb-2 [.border-t]:pt-2 order-last w-full justify-start',
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  },
)

export type InputGroupVariants = VariantProps<typeof inputGroupAddonVariants>

export const inputGroupButtonVariants = cva(
  'gap-2 rounded-md text-xs/relaxed flex items-center shadow-none',
  {
    variants: {
      size: {
        "xs": 'h-5 gap-1 rounded-[calc(var(--radius-sm)-2px)] px-1 [&>svg:not([class*=size-])]:size-3',
        "sm": 'gap-1',
        "icon-xs": 'size-6 p-0 has-[>svg]:p-0',
        "icon-sm": 'size-7 p-0 has-[>svg]:p-0',
      },
    },
    defaultVariants: {
      size: "xs",
    },
  },
)

export type InputGroupButtonVariants = VariantProps<typeof inputGroupButtonVariants>

export interface InputGroupButtonProps {
  variant?: string | null
  size?: InputGroupButtonVariants["size"]
  class?: HTMLAttributes["class"]
}
