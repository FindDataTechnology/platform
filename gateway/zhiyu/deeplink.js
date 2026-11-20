// ── Mobile→web hand-off links (openspec: add-zhiyu-mobile-clients 5.1/5.2) ────
//
// The mobile clients carry only: the room list, the message stream, read-only
// presence, and voice/text send. Everything with real state to manage — a
// private window, an invite, a fleet subscription, room settings — stays on the
// web. Mobile's job is to hand over a link.
//
// The link is a ONE-TIME permit, which is the whole point of it being separate
// from the share-link lane:
//
//   share link (`kind: 'link'`)  — a standing invitation, reusable until revoked,
//                                  because a poster has to be able to share it.
//   hand-off link (`zdl_…`)      — a single tap for one person, burned on first
//                                  open, because it is minted for a user who is
//                                  already authenticated on the phone and is
//                                  about to cross to a surface that requires
//                                  more authority than the phone was granted.
//
// Two properties are structural, not policed:
//   • the token carries NOTHING: `zdl_<id>.<sec>`, id is a database key and
//     only sha256(sec) is stored. No email, no room id, no session, no room
//     title — a URL that leaks into a chat log reveals nothing.
//   • the link cannot be re-minted by the bearer: minting requires an owner (or
//     member) session on the gateway. A consumed link does not refresh itself.

import crypto from "node:crypto";

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/**
 * The closed set of things mobile hands to web. A purpose outside this list is
 * a 400, not a new surface — the list is the definition of "heavy interaction"
 * (5.1), so adding one is a deliberate edit here rather than a client choice.
 */
export const DEEPLINK_PURPOSES = Object.freeze(["private_window", "invite", "subscription", "room_settings"]);

/** `zdl_<12 hex id>.<32 hex sec>`. Anything else is not a hand-off link. */
export const DEEPLINK_TOKEN_RE = /^zdl_[0-9a-f]{12}\.[0-9a-f]{32}$/;

/** Default lifetime: long enough to read the notice and tap, short enough to be stale by tomorrow. */
export const DEEPLINK_TTL_SEC = 15 * 60;

export function isDeeplinkPurpose(purpose) {
  return DEEPLINK_PURPOSES.includes(String(purpose ?? ""));
}

export function newDeeplinkToken() {
  const id = crypto.randomBytes(6).toString("hex");
  const sec = crypto.randomBytes(16).toString("hex");
  return { token: `zdl_${id}.${sec}`, id, secHash: sha256(sec) };
}

/** Split a presented token into its lookup key, or null when it is malformed. */
export function deeplinkIdOf(raw) {
  const token = String(raw ?? "").trim();
  if (!DEEPLINK_TOKEN_RE.test(token)) return null;
  const [head] = token.split(".");
  return head.slice("zdl_".length);
}

/**
 * Where the web lands after a hand-off. The landing path carries the room and
 * the panel — never a credential, and never the token (it is spent by the time
 * we get here).
 */
export function handoffPathFor(roomId, purpose) {
  const room = encodeURIComponent(String(roomId));
  switch (purpose) {
    case "private_window":
      return `/zhiyu/${room}?window=private`;
    case "invite":
      return `/zhiyu/${room}?panel=invite`;
    case "subscription":
      return `/zhiyu/${room}?panel=subscription`;
    case "room_settings":
      return `/zhiyu/${room}?panel=settings`;
    default:
      return `/zhiyu/${room}`;
  }
}

/**
 * Mint a hand-off link.
 *
 * Only `id` and the secret's hash are persisted; the caller is the only one who
 * ever sees the plaintext, once.
 */
export function mintDeeplink(store, { roomId, purpose, createdBy, ttlSec = DEEPLINK_TTL_SEC, now = Date.now }) {
  if (!isDeeplinkPurpose(purpose)) return { error: "unknown_purpose" };
  if (!roomId) return { error: "room_required" };
  const t = newDeeplinkToken();
  const expiresAt = now() + Math.max(60, Math.floor(Number(ttlSec) || DEEPLINK_TTL_SEC)) * 1000;
  store.deepLinkCreate({ id: t.id, roomId, purpose, secHash: t.secHash, createdBy, expiresAt });
  return { token: t.token, purpose, roomId, expiresAt };
}

/**
 * Verify a presented token WITHOUT spending it.
 *
 * Used by the page shell: the shell must be able to say "this link is dead"
 * before the SPA boots, but a HEAD/GET of an HTML shell must not consume the
 * link — the user has not opened anything yet. Spending happens in
 * `redeemDeeplink`, which the SPA calls once it is actually going to act.
 */
export function verifyDeeplink(store, raw, { now = Date.now } = {}) {
  const id = deeplinkIdOf(raw);
  if (!id) return null;
  const row = store.deepLinkGet(id);
  if (!row) return null;
  if (row.usedAt) return null;
  if (!(row.expiresAt > now())) return null;
  const [, sec] = String(raw).trim().split(".");
  const presented = sha256(String(sec));
  // Constant-time compare: the sec is a bearer secret.
  const a = Buffer.from(presented, "hex");
  const b = Buffer.from(String(row.secHash), "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: row.id, roomId: row.roomId, purpose: row.purpose, expiresAt: row.expiresAt };
}

/**
 * Spend the link. Second call with the same token returns null, which is the
 * assertion 5.2 rests on.
 */
export function redeemDeeplink(store, raw, { usedBy = null, now = Date.now } = {}) {
  const verified = verifyDeeplink(store, raw, { now });
  if (!verified) return null;
  const burned = store.deepLinkRedeem(verified.id, { usedBy });
  if (!burned) return null; // lost the race to a concurrent open
  return { roomId: verified.roomId, purpose: verified.purpose, path: handoffPathFor(verified.roomId, verified.purpose) };
}
