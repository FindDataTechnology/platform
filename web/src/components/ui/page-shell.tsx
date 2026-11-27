import * as React from "react"
import { cn } from "@/lib/utils"

// PageShell — the fixed heading hierarchy for work surfaces (web-design-system).
// It exists because the visual review found the page title routinely losing to
// filter bars and stat rows ("heading hierarchy collapse"). The contract is
// structural: title is always the first reading point; actions are right-anchored
// beside it; filters sit BELOW the header, never above it; the body scrolls
// inside the shell so the header stays put. Copy arrives as props.

export interface PageShellProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: React.ReactNode
  /** Test id for the heading itself, for surfaces whose title is asserted by
   *  e2e (the heading's text is the assertion; the id keeps the anchor). */
  titleTestId?: string
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  filters?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}

export function PageShell({
  title,
  titleTestId,
  subtitle,
  actions,
  filters,
  children,
  className,
  bodyClassName,
  ...props
}: PageShellProps) {
  return (
    <div className={cn("flex h-full flex-col overflow-hidden", className)} {...props}>
      {/* Below md a floating drawer toggle sits at the top-left (App shell), so
          the header reserves that gutter — otherwise the button covers the first
          glyph of every page title (measured 2026-11-09 at 640px: 「素材市场」
          lost its 材). Desktop keeps the normal padding. */}
      <header className="flex shrink-0 items-start justify-between gap-4 px-4 pb-3 pl-12 pt-4 md:px-6 md:pl-6">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-7 text-foreground" data-testid={titleTestId}>
            {title}
          </h1>
          {subtitle != null && <p className="mt-1 text-sm leading-5 text-muted-foreground">{subtitle}</p>}
        </div>
        {actions != null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {filters != null && <div className="shrink-0 px-4 pb-3 md:px-6">{filters}</div>}
      <div className={cn("min-h-0 flex-1 overflow-y-auto px-4 pb-4 md:px-6", bodyClassName)}>{children}</div>
    </div>
  )
}
