// Pure tab roving-focus step (web-design-system). Lives in lib/ so node --test
// can import it directly — ui/tabs.tsx re-exports it for consumers.

import type { ReactNode } from "react"

export interface TabItem {
  id: string
  label: ReactNode
  disabled?: boolean
}

export type TabKey = "ArrowRight" | "ArrowLeft" | "Home" | "End"

// Returns the next enabled index for a key, or -1 when nothing is enabled.
// Arrows wrap around; disabled tabs are stepped over in either direction.
export function tabFocusStep(items: { disabled?: boolean }[], from: number, key: TabKey): number {
  const n = items.length
  if (!n) return -1
  const enabled = (i: number) => i >= 0 && i < n && items[i] && !items[i].disabled
  if (key === "Home") {
    for (let i = 0; i < n; i++) if (enabled(i)) return i
    return -1
  }
  if (key === "End") {
    for (let i = n - 1; i >= 0; i--) if (enabled(i)) return i
    return -1
  }
  const dir = key === "ArrowRight" ? 1 : -1
  let cur = from
  for (let k = 0; k < n; k++) {
    cur = ((cur + dir) % n + n) % n
    if (enabled(cur)) return cur
  }
  return -1
}
