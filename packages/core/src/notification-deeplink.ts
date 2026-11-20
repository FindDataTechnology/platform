// notification-deeplink — what a room notification is allowed to carry
// (openspec: add-zhiyu-mobile-clients 6.1).
//
// A push notification is the one place a room's content escapes every access
// check we own: it is rendered on a lock screen, mirrored to a watch, quoted in
// a reply, and (on WeChat) materialized in a system UI we cannot redact. So the
// rule is not "filter the body out of the payload" — filtering is what leaks the
// day somebody adds a new content field. It is an ALLOWLIST: the template is
// built by pulling named keys, so a payload key that nobody listed cannot reach
// the notification even if it is full of text.
//
// Position is carried as a `seq` (an opaque ordinal), never as a snippet. The
// client uses it to scroll to the row after opening the room; it means nothing
// outside the room.

/** The only payload fields a notification template may read. */
export const NOTIFICATION_TEMPLATE_KEYS: readonly string[] = Object.freeze(["roomTitle", "seq", "from", "count"]);

export interface NoticeLike {
  id?: string;
  type?: string;
  roomId?: string | null;
  payload?: Record<string, unknown> | null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Where tapping this notification lands: the room, plus the seq to scroll to.
 *
 * Returns null when the notice names no room — a system-wide notice has nothing
 * to deep-link to, and inventing `/zhiyu` for it would open a list the user did
 * not ask for.
 */
export function notificationDeepLink(n: NoticeLike): { path: string; roomId: string; seq: number | null } | null {
  const roomId = str(n?.roomId);
  if (!roomId) return null;
  const raw = Number(n?.payload?.seq);
  const seq = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  const base = `/zhiyu/${encodeURIComponent(roomId)}`;
  return { path: seq === null ? base : `${base}?seq=${seq}`, roomId, seq };
}

/**
 * Subscription-message template parameters (WeChat `data` / APNs custom keys).
 *
 * Every value is a short string drawn from the allowlist above. `roomTitle` is
 * the room's NAME, which the recipient already sees in their room list — not a
 * message excerpt.
 */
export function notificationTemplateParams(n: NoticeLike, { maxTitleLen = 20 }: { maxTitleLen?: number } = {}): Record<string, string> {
  const p = (n?.payload ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  const title = str(p.roomTitle);
  if (title) out.roomName = clip(title, maxTitleLen);
  const seq = Number(p.seq);
  if (Number.isFinite(seq) && seq > 0) out.position = String(Math.floor(seq));
  const by = str(p.from);
  if (by) out.by = clip(by, 24);
  const count = Number(p.count);
  if (Number.isFinite(count) && count > 0) out.count = String(Math.floor(count));
  return out;
}

function clip(s: string, max: number): string {
  const n = Math.max(1, Math.floor(max));
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

/**
 * The set of keys a notification may ever render, for the guard the tests and
 * the sender-side assertion share. Exported as data so the check is a diff, not
 * a regex somebody can satisfy accidentally.
 */
export function templateKeys(): string[] {
  return [...NOTIFICATION_TEMPLATE_KEYS];
}
