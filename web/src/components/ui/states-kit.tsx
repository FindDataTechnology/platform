import * as React from "react"
import { Button } from "@/components/ui/button"
import { useMemo } from "react";
import { cn } from "@/lib/utils"

// StatesKit — the three states every fetched surface owes its user
// (web-design-system; batch ③ wires it page by page). The visual review's P1:
// half the app renders blank areas, bare "暂无数据" shrugs, or (worst) nothing
// at all while a lazy drawer loads (`fallback={null}`).
//   Skeleton   — shape-configurable placeholder blocks so loading keeps the
//                LAYOUT of the real content (same-shape rule), never a void.
//   EmptyState — states the reason and offers the next step (action slot); a
//                bare "no data" line is the failure mode this replaces.
//   ErrorState — names the problem and offers retry, without wiping the view.
// All copy arrives as props; the components own zero strings.

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-muted", className)} />
}

/** A ready-made list-of-rows skeleton: rows default to the common 1-line +
 * 2-line card rhythm. Consumers match their real row shape (same-shape rule). */
export function SkeletonList({ rows = 4, className }: { rows?: number; className?: string }) {
  // Static placeholder rows — no dynamic ordering, so index keys are noise;
  // generate named rows to satisfy noArrayIndexKey without suppression.
  const rowIds = useMemo(() => Array.from({ length: rows }, (_, i) => `skeleton-row-${i}`), [rows]);
  return (
    <div aria-hidden="true" className={cn("flex flex-col gap-3", className)}>
      {rowIds.map((id) => (
        <div key={id} className="rounded-md border border-border bg-card p-4">
          <Skeleton className="mb-2 h-4 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  )
}

export interface EmptyStateProps {
  title: string
  hint?: React.ReactNode
  /** The way forward: a real control (Button/Link). Present unless the empty
   * state is a terminal fact (e.g. "no results for this filter" clears itself). */
  action?: React.ReactNode
  icon?: React.ReactNode
  className?: string
}

export function EmptyState({ title, hint, action, icon, className }: EmptyStateProps) {
  return (
    <div
      role="note"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md border border-border bg-card/60 px-6 py-10 text-center",
        className
      )}
    >
      {icon != null && <div className="text-muted-foreground">{icon}</div>}
      <div className="text-sm font-medium text-foreground">{title}</div>
      {hint != null && <div className="max-w-[46ch] text-xs leading-5 text-muted-foreground">{hint}</div>}
      {action != null && <div className="mt-2">{action}</div>}
    </div>
  )
}

export interface ErrorStateProps {
  message: string
  onRetry?: () => void
  /** Locale-supplied label for the retry control; the component holds no string. */
  retryLabel?: string
  className?: string
}

export function ErrorState({ message, onRetry, retryLabel, className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md border border-status-failed/40 bg-card px-6 py-8 text-center",
        className
      )}
    >
      <div className="text-sm font-medium text-status-failed">{message}</div>
      {onRetry && retryLabel && (
        <Button type="button" size="sm" variant="outline" className="mt-1" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  )
}
