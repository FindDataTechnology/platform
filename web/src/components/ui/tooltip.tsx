import * as React from "react"
import { cn } from "@/lib/utils"

// Tooltip — the replacement for bare `title=` across the site (web-design-system).
// Appears after a 300ms hover delay, immediately on keyboard focus (a focused
// user already waited), closes on blur/Escape. Content arrives as props.

export const TOOLTIP_SHOW_DELAY = 300

export interface TooltipProps {
  content: React.ReactNode
  side?: "top" | "bottom"
  delayMs?: number
  children: React.ReactElement
  className?: string
}

export function tooltipShouldOpenOnFocus(): boolean {
  // keyboard users have paid the "focus" cost already — zero delay (pure, testable)
  return true
}

export function Tooltip({ content, side = "top", delayMs = TOOLTIP_SHOW_DELAY, children, className }: TooltipProps) {
  const [open, setOpen] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const show = (immediate: boolean) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), immediate ? 0 : delayMs)
  }
  const hide = () => {
    if (timer.current) clearTimeout(timer.current)
    setOpen(false)
  }
  return (
    <span
      className={cn("relative inline-flex", className)}
      onMouseEnter={() => show(false)}
      onMouseLeave={hide}
      onFocus={() => show(tooltipShouldOpenOnFocus())}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === "Escape") hide()
      }}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={cn(
            "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground",
            side === "top" ? "bottom-full mb-1" : "top-full mt-1"
          )}
        >
          {content}
        </span>
      )}
    </span>
  )
}
