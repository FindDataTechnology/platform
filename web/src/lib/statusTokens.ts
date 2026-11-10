// Semantic status → theme-token mapping (web-design-system, task 1.2).
// Single source consumed by StatusPill and every batch-②③ surface that needs
// a runtime state color. Colors never carry meaning alone: a status always
// ships with its label (see specs/web-design-system).

export type StatusKind = "running" | "paused" | "failed" | "waiting" | "neutral";

export const STATUS_TOKENS: Record<StatusKind, string> = {
  running: "--color-status-running",
  paused: "--color-status-paused",
  failed: "--color-status-failed",
  waiting: "--color-status-waiting",
  neutral: "--color-muted-foreground",
};

export const STATUS_KINDS: StatusKind[] = ["running", "paused", "failed", "waiting", "neutral"];

// Unknown or absent state degrades to neutral — display-side fail-open, same
// posture as every optional surface in this product.
export function statusToken(status: string | null | undefined): string {
  return status && (status as StatusKind) in STATUS_TOKENS
    ? STATUS_TOKENS[status as StatusKind]
    : STATUS_TOKENS.neutral;
}

// Normalizes arbitrary server-side state words to the five kinds; anything
// unmapped is neutral (never an invented sixth color).
export function asStatusKind(value: string | null | undefined): StatusKind {
  const v = (value ?? "").toLowerCase();
  if (v === "running" || v === "active" || v === "streaming" || v === "live") return "running";
  if (v === "paused" || v === "idle" || v === "parked" || v === "waiting_user" || v === "stalled") return "paused";
  if (v === "failed" || v === "error" || v === "failing" || v === "down" || v === "unhealthy") return "failed";
  if (v === "waiting" || v === "pending" || v === "queued" || v === "approved_pending" || v === "needs_attention") return "waiting";
  return "neutral";
}
