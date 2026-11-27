// Non-chat room rows: ONE catalog, ONE visibility rule.
//
// The in-app room page and the visitor-facing embed page used to keep two
// separate event-name lists. They drifted: `im_delivery_failed` landed as a
// `kind:"system"` row, the room page's filter only knew `kind === "event"`,
// and the raw i18n key `zhiyu.event.im_delivery_failed` reached the screen
// (19 of them in one production room, 2026-11-18). Keys listed here MUST
// exist in web/src/locales/*/common.json — scripts/check-locale-coverage.mjs
// enforces the code→en direction.
//
// Scope of "non-chat": anything that is not a human/agent utterance. Both
// `event` and `system` kinds belong to it, and the rule below treats them
// identically — that is the whole point of this module.

/** Event names that render as a centered status line. `meta.event` values. */
export const NON_CHAT_EVENT_KEYS = [
  "member_joined",
  "member_left",
  "member_removed",
  "invite_sent",
  "invite_accepted",
  "invite_declined",
  "invite_auto_declined",
  "room_ended",
  "room_hatched",
  "room_renamed",
  "reply_cap_changed",
  "budget_changed",
  "reply_cap_hit",
  "budget_exhausted",
  "agent_busy",
  "agent_failed",
  "agent_failed_retryable",
  "settle_unbilled",
  "settle_unbilled_expected",
  "agent_declined_insolvent",
  "pass",
  "all_passed",
  "needs_you",
  "take_over",
  "hand_back",
  "owner_transferred",
  "guest_joined",
  "guest_identified",
  // IM bridge: an answer never made it back to the group. The row's CONTENT
  // carries the human sentence; this key is the fallback for older rows.
  "im_delivery_failed",
  // Routing trail (add-voice-routing 6.1): decision rows carry actions and are
  // rendered specially by the room page, but they are non-chat rows too.
  "route_decision",
  "route_cancelled",
  "route_reassigned",
  // Room commander (add-room-commander). The receipt is the room's proof of life
  // while seats work; commander_none is why nobody answered. Without these the
  // rows would be invisible here while the group saw them — the exact
  // two-lists-drift failure this catalog exists to prevent.
  "commander_decision",
  "commander_receipt",
  "commander_none",
  "commander_degraded",
] as const;

const KNOWN = new Set<string>(NON_CHAT_EVENT_KEYS);

export interface NonChatRow {
  kind: string;
  content?: string | null;
  meta?: Record<string, unknown> | null;
}

export const isNonChatRow = (row: NonChatRow): boolean => row.kind === "event" || row.kind === "system";

/**
 * The catalog key for a non-chat row, or null when the row's event is not in
 * the catalog. Two labels are derived rather than stored: the busy-vs-broken
 * split (agent_failed + retryable) and the showcase-room split
 * (settle_unbilled + expected). Deriving them HERE is what keeps the room page
 * and the embed page from disagreeing about the same row.
 */
export function nonChatLabelKey(row: NonChatRow): string | null {
  const base = String(row.meta?.event ?? "");
  if (base === "agent_failed" && row.meta?.retryable === true) return "agent_failed_retryable";
  if (base === "settle_unbilled" && row.meta?.expected === true) return "settle_unbilled_expected";
  return KNOWN.has(base) ? base : null;
}

/**
 * Whether a non-chat row is shown at all. A row is readable when it carries its
 * own text (greetings, fleet reports, the IM failure sentence) or when its
 * event has a label. Everything else stays out of the stream: an unregistered
 * internal event name must never be shown to a member or a visitor.
 */
export function nonChatVisible(row: NonChatRow): boolean {
  if (!isNonChatRow(row)) return true;
  if (String(row.content ?? "").trim()) return true;
  return nonChatLabelKey(row) !== null;
}

/** Shape the interpolation values a label may use. Shared so both pages agree. */
export function nonChatLabelParams(row: NonChatRow): Record<string, string> {
  const m = (row.meta ?? {}) as Record<string, unknown>;
  const member = m.member as { display?: string } | undefined;
  // `commander_receipt` carries the seats it dispatched to, not a single name.
  const seats = Array.isArray(m.seats) ? m.seats.map(String).filter(Boolean) : [];
  return {
    name: String(m.display ?? member?.display ?? m.by ?? m.to ?? (seats.length ? seats.join("、") : "")),
    value: String(m.effective ?? m.replyCap ?? m.dailyBudgetTurns ?? ""),
  };
}
