import * as React from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { toastReduce, TOAST_TTL, TOAST_MAX_VISIBLE } from "@/lib/toastCore"
import type { ToastItem, ToastSeverity, ToastState } from "@/lib/toastCore"

// Toast v2 — queued multi-slot feedback (web-design-system).
// Module-level bus (same posture as the old Toast.tsx, so ③ rewires pages in one
// line each): push up to TOAST_MAX_VISIBLE on screen, the rest waits FIFO;
// severity sets the dwell time and error is always manually closable. ALL copy
// arrives as props — the host takes closeLabel for its close button.

export type { ToastSeverity, ToastItem }
export { TOAST_TTL, TOAST_MAX_VISIBLE }

let seq = 0
let state: ToastState = { visible: [], queued: [] }
const listeners = new Set<() => void>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()
const emit = () => {
  for (const l of listeners) l()
}

export function dismissToast(id: number) {
  const t = timers.get(id)
  if (t) {
    clearTimeout(t)
    timers.delete(id)
  }
  const next = toastReduce(state, { type: "dismiss", id })
  if (next !== state) {
    state = next
    emit()
  }
}

export function showToast(input: {
  severity: ToastSeverity
  title: string
  description?: string
  action?: ToastItem["action"]
  ttlMs?: number
}): number {
  const item: ToastItem = {
    id: ++seq,
    severity: input.severity,
    title: input.title,
    description: input.description,
    action: input.action,
    ttlMs: input.ttlMs ?? TOAST_TTL[input.severity],
  }
  state = toastReduce(state, { type: "push", item })
  emit()
  // The timer targets the DISMISS action, which is idempotent — a toast
  // promoted from the queue before its push-time would not carry this timer;
  // the timer covers the item by id regardless of slot placement.
  if (item.ttlMs > 0) {
    timers.set(item.id, setTimeout(() => dismissToast(item.id), item.ttlMs))
  }
  return item.id
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function useToasts(): ToastState {
  return React.useSyncExternalStore(
    subscribe,
    () => state,
    () => state
  )
}

const SEVERITY_EDGE: Record<ToastSeverity, string> = {
  success: "border-status-running/40",
  info: "border-border",
  error: "border-status-failed/50",
}

export interface ToastV2HostProps {
  /** Accessible name for the close button (locale-supplied; the component holds
   * no strings). Without it the auto-dismiss timer still closes — but error
   * toasts lose their manual close, so always pass it from the app root. */
  closeLabel: string
}

export function ToastV2Host({ closeLabel }: ToastV2HostProps) {
  const { visible } = useToasts()
  if (!visible.length) return null
  return createPortal(
    <div
      role="region"
      aria-live="polite"
      data-testid="toast-v2-host"
      className="pointer-events-none fixed bottom-6 left-1/2 z-[70] flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2"
    >
      {visible.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex items-start justify-between gap-3 rounded-md border bg-card px-4 py-2.5 text-sm text-card-foreground shadow-lg",
            SEVERITY_EDGE[t.severity]
          )}
        >
          <div className="min-w-0">
            <div className="font-medium leading-5">{t.title}</div>
            {t.description && <div className="mt-0.5 text-xs text-muted-foreground">{t.description}</div>}
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action?.onClick()
                  dismissToast(t.id)
                }}
                className="mt-1.5 text-xs font-medium text-primary underline-offset-4 hover:underline"
              >
                {t.action.label}
              </button>
            )}
          </div>
          {(t.severity === "error" || t.action) && (
            <button
              type="button"
              aria-label={closeLabel}
              onClick={() => dismissToast(t.id)}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body
  )
}
