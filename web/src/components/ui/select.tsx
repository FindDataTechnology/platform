import * as React from "react"
import { cn } from "@/lib/utils"

// Select — the themed wrapper over the NATIVE select (design D2: no combobox).
// Native gives focus, typing, IME and screen-reader semantics for free, so the
// 23 hand-rolled `<select>` sites can move in one tag swap. Options are plain
// children, exactly as with the native element.

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
)
Select.displayName = "Select"

export { Select }
