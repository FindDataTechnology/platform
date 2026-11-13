// mobile-handoff — the boundary between what the phone does and what it hands
// to the web (openspec: add-zhiyu-mobile-clients 5.1 / 5.2).
//
// The temptation with a mobile client is to grow a simplified version of each
// web surface: a compact invite sheet, a one-line private window, a small
// subscription toggle. Every one of those is a SECOND implementation of a
// permission model, and the two drift — the phone ends up granting a history
// scope the web would have refused, or hiding a window the web would have
// shown. So the rule is structural rather than aspirational: the phone carries
// four things (list, stream, read-only presence, send) and every stateful
// interaction leaves the app through a ONE-TIME link.
//
// This module is that boundary as data. The clients do not each decide which
// actions are "heavy" — they ask here, and the three/four entries below are the
// complete list. The server's mint endpoint rejects anything else
// (`gateway/zhiyu/deeplink.js`, DEEPLINK_PURPOSES), so "mobile grew a fifth
// surface" cannot happen on one side alone.

/** What a mobile client MAY do locally. Anything absent from this list leaves the app. */
export const MOBILE_LOCAL_CAPABILITIES: readonly string[] = Object.freeze([
  "rooms.list",
  "room.stream",
  "room.presence.read",
  "room.message.send",
]);

/**
 * The heavy interactions: state on the server that needs more authority than the
 * phone session was granted, or a multi-step flow that only exists on the web.
 *
 * `target` is the web surface named in the user-facing copy, so the client does
 * not invent its own wording per platform.
 */
export const MOBILE_HANDOFF_ACTIONS: readonly {
  readonly action: string;
  readonly target: string;
  /** True when the web surface is owner-only; the phone still mints, the web re-checks. */
  readonly ownerOnly: boolean;
}[] = Object.freeze([
  { action: "private_window", target: "web.room.private", ownerOnly: false },
  { action: "invite", target: "web.room.invite", ownerOnly: true },
  { action: "subscription", target: "web.room.subscription", ownerOnly: false },
  { action: "room_settings", target: "web.room.settings", ownerOnly: true },
]);

export function isHandoffAction(action: string): boolean {
  return MOBILE_HANDOFF_ACTIONS.some((a) => a.action === action);
}

export function handoffActionFor(action: string): (typeof MOBILE_HANDOFF_ACTIONS)[number] | null {
  return MOBILE_HANDOFF_ACTIONS.find((a) => a.action === action) ?? null;
}

/** Whether a capability may be implemented inside the app at all. */
export function mobileMayDo(capability: string): boolean {
  return MOBILE_LOCAL_CAPABILITIES.includes(capability);
}

/**
 * The one request shape both clients send when the user taps a hand-off.
 *
 * Returned as data (path + body) rather than performed here, because core has no
 * HTTP client — the caller injects one (web uses `fetch`, the mini-program uses
 * `Taro.request`). Keeping the shape in one place is what stops the two clients
 * from sending different bodies to one endpoint.
 */
export function handoffRequest(action: string, roomId: string): { path: string; method: "POST"; body: { purpose: string } } | null {
  if (!isHandoffAction(action) || !roomId) return null;
  return { path: `/api/zhiyu/rooms/${encodeURIComponent(roomId)}/deeplink`, method: "POST", body: { purpose: action } };
}

/**
 * Normalize the mint response into what a client renders.
 *
 * Both fields are checked: a response without a URL is a failure the caller must
 * surface, not a link it can silently open.
 */
export function handoffLinkFrom(response: unknown): { url: string; path: string; purpose: string; expiresAt: number } | null {
  const r = response as { url?: unknown; path?: unknown; purpose?: unknown; expiresAt?: unknown } | null;
  if (!r || typeof r.url !== "string" || !r.url) return null;
  if (typeof r.path !== "string" || !r.path) return null;
  const expiresAt = Number(r.expiresAt);
  return {
    url: r.url,
    path: r.path,
    purpose: String(r.purpose ?? ""),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
  };
}

/** Expired links are shown as expired rather than tapped into a 404. */
export function handoffIsExpired(link: { expiresAt: number }, now: number = Date.now()): boolean {
  return !(Number(link?.expiresAt) > now);
}
