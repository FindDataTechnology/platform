import * as React from "react"
import { cn } from "@/lib/utils"

// Card — the surface primitive of the foundation kit (web-design-system).
// Elevation is declared once: the hairline border IS the elevation; there is no
// shadow stacked under it (a 1px border under a soft shadow is the ghost card).
// All copy arrives as props — the component owns zero strings.

export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title?: React.ReactNode
  actions?: React.ReactNode
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, title, actions, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("rounded-md border border-border bg-card p-4 text-card-foreground", className)}
      {...props}
    >
      {(title != null || actions != null) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          {title != null && <div className="min-w-0 text-sm font-semibold leading-6">{title}</div>}
          {actions != null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  )
)
Card.displayName = "Card"

export { Card }
