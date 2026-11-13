// ── Voice attribution (add-speaker-attribution, group 4) ────────────────────
//
// Who spoke? For a meeting capture the answer is structural, not acoustic:
// **every capture stream is one person** (design D8). Each stream comes from one
// device — or one seat's capture — so "who" is decided by where the audio came
// from, not by what it sounds like.
//
// That leaves exactly two pieces of evidence, the two the spec allows:
//
//   self_declaration — someone confirmed, before recording started, that this
//                      stream is theirs (录音开始前的一次性参与者确认)
//   seat_binding     — the stream belongs to a seat whose owner is known
//
// Anything else is `anonymous`, and the router turns that into
// `needs_confirmation` (voice-router 2.4). There is deliberately NO third
// input: no audio features, no embedding comparison, no similarity score, and
// no memory of a previous session. 「听起来像张三」 is the one thing this
// platform has decided never to route on — 声纹永不参与身份判定，更永不作认证
// 因子. Anything that computes a distance between two voices belongs in a
// different file, in a different product, after a different decision.
//
// Why `session` outranks `bound` when both are present: a seat binding says who
// usually sits there, a declaration says who is sitting there NOW. Meeting rooms
// get borrowed; the person who confirmed the stream is the newer and more
// specific fact.
//
// `memberId` here is the ROOM member the stream belongs to — the "person" of
// the task, expressed in the vocabulary the router already uses. It is NOT the
// transcription's `speaker` field: that one is an upstream cluster label and is
// never copied into an identity by this module.

/** The only certainties this module can emit, in the spec's vocabulary. */
export const ATTRIBUTION_CERTAINTY = Object.freeze(["session", "bound", "anonymous"]);

/** Capture modes. `mixed` = one microphone for the whole room (design D8). */
export const CAPTURE_MODE = Object.freeze(["per_stream", "mixed"]);

/** Evidence sources, for the audit trail. `none` is a fact, not an omission. */
export const ATTRIBUTION_SOURCE = Object.freeze(["self_declaration", "seat_binding", "none"]);

// A blank string is not a person. Trim, and treat everything non-string as
// absent, so a malformed stream record degrades to `anonymous` instead of
// routing to a member called "".
function memberOf(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s || null;
}

function result(streamId, memberId, certainty, source, reason) {
  return { streamId, memberId, certainty, source, reason };
}

/**
 * Attribute every stream of ONE capture session.
 *
 * @param {object}   opts
 * @param {"per_stream"|"mixed"} opts.mode  one stream per person, or one mic for the room
 * @param {Array}    opts.streams           [{ streamId, declaredMemberId?, seatOwnerMemberId? }]
 * @returns {Array<{streamId, memberId, certainty, source, reason}>}
 *
 * Purity is the point: the same input always yields the same attribution, and
 * there is no parameter through which a previous session could leak in.
 */
export function attributeStreams({ mode = "per_stream", streams = [] } = {}) {
  const mixed = mode === "mixed";
  const list = Array.isArray(streams) ? streams : [];
  return list.map((stream) => {
    const streamId = typeof stream?.streamId === "string" && stream.streamId.trim() ? stream.streamId.trim() : null;

    // Without a stream id there is nothing to attach an attribution to: the
    // answer could not be looked up later, and a positional guess would be a
    // guess. Malformed input degrades to "we don't know", never to a person.
    if (!streamId) {
      return result(null, null, "anonymous", "none", "采集流缺少标识，无法把归属挂到任何一路音频上");
    }

    // A single microphone cannot tell two people apart, and no declaration
    // changes that: 「我是张三」 on a shared mic proves who is in the room, not
    // which sentence is theirs. Recording every line to the person who spoke
    // first would look like evidence and be the worst kind of guess.
    if (mixed) {
      return result(streamId, null, "anonymous", "none", "整个房间只有一路采集，无法区分是谁在说");
    }

    const declared = memberOf(stream?.declaredMemberId);
    if (declared) return result(streamId, declared, "session", "self_declaration", "本场已确认这一路采集属于该成员");

    const bound = memberOf(stream?.seatOwnerMemberId);
    if (bound) return result(streamId, bound, "bound", "seat_binding", "该席位的已知主人");

    return result(streamId, null, "anonymous", "none", "这一路采集在本场没有归属证据");
  });
}

/**
 * The `attribution` argument `decideAddressee` expects. Kept as a function so
 * callers cannot hand-roll the mapping and accidentally promote an anonymous
 * stream to a certain one.
 */
export function toRouterAttribution(attribution) {
  const certainty = ATTRIBUTION_CERTAINTY.includes(attribution?.certainty) ? attribution.certainty : "anonymous";
  return { certainty, memberId: attribution?.memberId ?? null };
}
