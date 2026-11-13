// ── The voiceRoute seam: capture evidence → a routing decision ───────────────
//
// room-router has carried a `voiceRoute` injection point since add-voice-routing
// 3.1, documented as "({room, member, message, agents}) → a decideAddressee()
// result, or null to mean 'not this room's policy'". Nothing ever supplied one,
// so every room still broadcast. This is the supplier.
//
// Three things make it safe to ship before the capture lane exists:
//
//   1. NO EVIDENCE → null. A message without `meta.capture` is not a capture
//      message, and `null` is the documented "not my policy" answer. Typed
//      messages, agent events and every row written before this contract keep
//      the legacy broadcast byte for byte.
//   2. The router is not touched. Attribution is computed by the pure module in
//      voice-attribution.js and handed to the existing decideAddressee, which
//      already ranks mention > attribution > intent.
//   3. The room's real schema is translated here, not assumed. There is no team
//      entity in a room (design D9): a person is a `kind:'user'` member whose
//      `ref` is their email, and the seats that ride for them are the
//      agent/facade members whose `on_behalf_of` is that same email. The router
//      asks "the speaker's own teams" by `ownerMemberId`, so the seats are
//      presented that way — and resolveSeat() maps the chosen id straight back
//      to the same seat.

import { attributeStreams, toRouterAttribution } from "./voice-attribution.js";
import { decideAddressee } from "./voice-router.js";

/**
 * The capture evidence on one message (design D9):
 *   { streamId, mode, declaredMemberId?, seatOwnerMemberId? }
 *
 * Read defensively: anything else answers null, which keeps the message on the
 * legacy path rather than inventing an attribution from a half-filled record.
 */
export function captureEvidence(message) {
  const raw = message?.meta?.capture;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const streamId = typeof raw.streamId === "string" && raw.streamId.trim() ? raw.streamId.trim() : null;
  if (!streamId) return null;
  const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    streamId,
    // Only the two capture modes exist; an unknown mode must not read as
    // per-stream (that would silently enable attribution for a shape we do not
    // understand). It reads as `mixed`, which attributes nobody.
    mode: raw.mode === "per_stream" ? "per_stream" : "mixed",
    declaredMemberId: text(raw.declaredMemberId),
    seatOwnerMemberId: text(raw.seatOwnerMemberId),
  };
}

/**
 * Does this seat answer for the room right now? Same rule the legacy broadcast
 * uses: active, and not a facade whose principal has taken the wheel
 * (`presence:'listening'`). The translation must not be more eager than the
 * broadcast it replaces.
 */
function seatWakeable(seat) {
  if (!seat || seat.state !== "active") return false;
  if (seat.kind === "facade" && seat.presence === "listening") return false;
  return true;
}

/**
 * Translate room seats into the shape decideAddressee reads. `ownerMemberId` is
 * the seat's `onBehalfOf` (the person's email); a seat with no owner is kept
 * with a null owner so it can still be reached by name, never by attribution.
 */
export function seatsAsRoomTeams(agents) {
  return (Array.isArray(agents) ? agents : [])
    .filter((seat) => seat && typeof seat === "object")
    .map((seat) => ({
      id: seat.id,
      ref: seat.ref,
      display: seat.display ?? seat.ref ?? "",
      ownerMemberId: typeof seat.onBehalfOf === "string" && seat.onBehalfOf.trim() ? seat.onBehalfOf.trim() : null,
      visible: seat.state !== "left",
      callable: seatWakeable(seat) ? true : false,
      reason: seatWakeable(seat) ? null : "seat_not_wakeable",
    }));
}

/**
 * Build the `voiceRoute` implementation for registerZhiyuRoutes.
 *
 * @param {object}   opts
 * @param {Function} opts.decide  the router (injectable for tests)
 * @returns {(args:{room,member,message,agents}) => object|null}
 */
export function createVoiceRoute({ decide = decideAddressee } = {}) {
  return function voiceRoute({ message, agents }) {
    const evidence = captureEvidence(message);
    if (!evidence) return null; // not a capture message → legacy behaviour

    const attribution = attributeStreams({ mode: evidence.mode, streams: [evidence] })[0];
    // Seats that left are dropped here rather than trusted to the caller: the
    // router's broadcast branch picks from `roomSeats` without re-checking
    // state, so passing a fuller list than production's would wake a departed
    // agent. A listening facade is KEPT (it stays mentionable exactly as
    // today) — the broadcast branch already excludes it by its own rule.
    const seats = (Array.isArray(agents) ? agents : []).filter(
      (a) => a && typeof a === "object" && a.kind !== "user" && a.state === "active",
    );
    return decide({
      utterance: String(message?.content ?? ""),
      attribution: toRouterAttribution(attribution),
      roomTeams: seatsAsRoomTeams(seats),
      // 「@李四的助手」 must keep working exactly as it did on the broadcast path.
      roomSeats: seats,
      roomPolicy: {},
    });
  };
}
