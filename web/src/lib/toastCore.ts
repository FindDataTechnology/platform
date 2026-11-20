// Toast v2 pure core (web-design-system). Queue rules and severities live here
// so node --test can pin them without a DOM; ui/toast.tsx wires the store/host.

export type ToastSeverity = "success" | "error" | "info"

export interface ToastItem {
  id: number
  severity: ToastSeverity
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
  ttlMs: number
}

export const TOAST_TTL: Record<ToastSeverity, number> = {
  success: 3000,
  info: 4000,
  error: 8000,
}

export const TOAST_MAX_VISIBLE = 3

export interface ToastState {
  visible: ToastItem[]
  queued: ToastItem[]
}

export type ToastAction =
  | { type: "push"; item: ToastItem }
  | { type: "dismiss"; id: number }

// At TOAST_MAX_VISIBLE the push queues; a dismiss promotes the oldest queued
// item into the freed slot (FIFO). Dismissing an unknown id is a no-op so a
// late timer after a manual close cannot corrupt the list (idempotent close).
export function toastReduce(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case "push": {
      if (state.visible.length >= TOAST_MAX_VISIBLE) {
        return { visible: state.visible, queued: [...state.queued, action.item] }
      }
      return { visible: [...state.visible, action.item], queued: state.queued }
    }
    case "dismiss": {
      const visible = state.visible.filter((t) => t.id !== action.id)
      if (visible.length === state.visible.length) return state
      const promoted = state.queued[0]
      if (promoted && visible.length < TOAST_MAX_VISIBLE) {
        return { visible: [...visible, promoted], queued: state.queued.slice(1) }
      }
      return { visible, queued: state.queued }
    }
  }
}
