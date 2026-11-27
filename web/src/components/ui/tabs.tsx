import * as React from "react"
import { cn } from "@/lib/utils"
import { tabFocusStep } from "@/lib/tabsCore"
import type { TabKey } from "@/lib/tabsCore"
import type { TabItem } from "@/lib/tabsCore"

// Tabs — one keyboard contract for every tab bar (web-design-system).
// Automatic activation per the spec: arrows move focus AND the view (the panel
// follows the selected tab), Home/End jump to the first/last enabled tab,
// disabled tabs are stepped over. The parent renders the active panel; this
// component owns only the tablist. Copy arrives via items — zero strings here.

export { tabFocusStep }
export type { TabItem }

export interface TabsProps {
  items: TabItem[]
  value: string
  onChange: (id: string) => void
  className?: string
  /** Prefix for generated tab ids; pass one when panels wire aria-controls. */
  idPrefix?: string
  ariaLabel?: string
  /** Extra attributes per tab button. Hosts that own a public test contract
   *  (data-testid / data-active asserted by e2e) pass them here instead of
   *  hand-rolling a second tab bar — that is what this prop exists to prevent.
   *  The primitive keeps owning role, selection and the keyboard contract. */
  itemProps?: (id: string) => Record<string, string | number | boolean | undefined>
}

export function Tabs({ items, value, onChange, className, idPrefix, ariaLabel, itemProps }: TabsProps) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (e: React.KeyboardEvent) => {
    const key = e.key as TabKey
    if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return
    e.preventDefault()
    const from = items.findIndex((t) => t.id === value)
    const next = tabFocusStep(items, from < 0 ? 0 : from, key)
    const target = next >= 0 ? items[next] : undefined
    if (target) {
      onChange(target.id)
      refs.current[next]?.focus()
    }
  }
  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn("flex items-center gap-1", className)}
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          ref={(el) => {
            refs.current[i] = el
          }}
          role="tab"
          id={idPrefix ? `${idPrefix}-tab-${item.id}` : undefined}
          aria-selected={item.id === value}
          disabled={item.disabled}
          tabIndex={item.id === value ? 0 : -1}
          onClick={() => onChange(item.id)}
          {...itemProps?.(item.id)}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50",
            item.id === value
              ? "bg-primary-deep text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            itemProps?.(item.id)?.className as string | undefined
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
