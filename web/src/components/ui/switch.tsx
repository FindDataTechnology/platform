import * as React from "react"
import { cn } from "@/lib/utils"

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}

const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, checked, onCheckedChange, ...props }, ref) => {
    return (
      <label className="relative inline-flex items-center cursor-pointer">
        {/* The input IS the interactive surface: it spans the whole track
            (transparent, on top) so clicks land on it directly. A sr-only
            input covered by the visual track only toggles via label
            activation, which synthetic click tools (Playwright) refuse to
            do — the track intercepts pointer events over the 1px input. */}
        <input
          type="checkbox"
          role="switch"
          className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
          checked={checked}
          onChange={(e) => onCheckedChange?.(e.target.checked)}
          ref={ref}
          {...props}
        />
        <div className={cn(
          "relative peer h-6 w-11 rounded-full bg-input transition-colors",
          "peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
          "peer-checked:bg-primary-deep",
          // Thumb. `background` rather than a literal white so it stays legible
          // against the track in both themes.
          "after:absolute after:top-[2px] after:start-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-border after:bg-background after:transition-all after:content-['']",
          "peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full",
          className
        )} />
      </label>
    )
  }
)
Switch.displayName = "Switch"

export { Switch }
