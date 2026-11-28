import * as React from "react"
import { cn } from "@/lib/utils"
import type { StatusKind } from "@/lib/statusTokens"

// StatusPill — the only carrier of status color (web-design-system).
// Color never speaks alone: `label` is required and carries the state in text;
// the dot is a decoration (aria-hidden). Backgrounds are a 12% tint of the
// status token, text is the token itself — both resolve through the four
// semantic aliases pinned in globals.css and checked by test-palette-contrast.

const PILL: Record<StatusKind, string> = {
  running: "bg-status-running/12 text-status-running",
  paused: "bg-status-paused/12 text-status-paused",
  failed: "bg-status-failed/12 text-status-failed",
  waiting: "bg-status-waiting/12 text-status-waiting",
  neutral: "bg-muted text-muted-foreground",
}

export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: StatusKind
  label: string
  /** Leading dot; defaults on. The label always carries the meaning anyway. */
  dot?: boolean
}

export function StatusPill({ status, label, dot = true, className, ...props }: StatusPillProps) {
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        PILL[status] ?? PILL.neutral,
        className
      )}
      {...props}
    >
      {dot && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />}
      {label}
    </span>
  )
}
