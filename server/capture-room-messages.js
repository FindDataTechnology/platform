// ── Capture → room messages (openspec: add-speaker-attribution, D9) ─────────
//
// The router decides per MESSAGE; a capture is a multi-person document. So the
// landing splits it: one message per consecutive stretch of one speaker, each
// carrying that stretch's own evidence (`meta.capture`). The spec's hard rule —
// 一条消息 MUST NOT 同时声称是两个人说的话 — is why grouping is by speaker and
// never by chunk.
//
// A stretch with no name is NOT folded into its neighbour. Borrowing the next
// speaker's name is the pseudo-label this capability exists to prevent, and it
// would route a stranger's words to whoever happened to talk next. An unnamed
// stretch stays unnamed, carries no person, and the router answers
// `needs_confirmation` — the correct failure, not a guess.
//
// What this function never does: claim a person the merge did not label. The
// labels it reads are the ones `mergedView` produced from bindings and the
// session declaration — the only two legal sources (D4).

import { joinTranscripts } from "./voice-capture.js";

/** The room's own ceiling on one human message (`/api/zhiyu/rooms/:id/messages`). */
export const CAPTURE_MESSAGE_MAX = 16_000;

function splitLong(text) {
  if (text.length <= CAPTURE_MESSAGE_MAX) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += CAPTURE_MESSAGE_MAX) out.push(text.slice(i, i + CAPTURE_MESSAGE_MAX));
  return out;
}

/**
 * The `meta` a message carries into the room.
 *
 * `mode: "per_stream"` when the stretch has a name (the evidence is that
 * person's own capture); `"mixed"` when it does not — which the router reads as
 * `anonymous`, i.e. ask rather than broadcast. `streamId` is always set: a
 * capture stretch without an id could not be looked up later, and
 * `captureEvidence()` would drop the whole record.
 */
function metaFor({ capture, member, cluster }) {
  const declared = capture?.speakerMode === "session" ? (capture.owner ?? null) : null;
  const seatOwner = declared ? null : (member ?? null);
  // A meeting stream is named after the MEETING, not the capture: a capture is a
  // platform-side id that changes if that stream is abandoned and recorded
  // again, while the meeting id is what the whole room can reason about. A
  // standalone capture keeps the old shape, byte for byte.
  const streamRoot = capture?.meetingId ? `${capture.meetingId}` : (capture?.id ?? "capture");
  return {
    source: "capture",
    captureId: capture?.id ?? null,
    title: capture?.title ?? null,
    meetingId: capture?.meetingId ?? null,
    capture: {
      streamId: `${streamRoot}#${cluster ?? member ?? "unknown"}`,
      mode: declared || seatOwner ? "per_stream" : "mixed",
      ...(declared ? { declaredMemberId: declared } : {}),
      ...(seatOwner ? { seatOwnerMemberId: seatOwner } : {}),
    },
  };
}

/**
 * Split one finished capture into the messages its room should receive.
 *
 * Takes `mergedView()`'s own result rather than loose arrays: the first version
 * took `{chunks, segments}` and a caller passed `{rows, merged}`, which fell
 * through to the "no separation" branch and silently shipped a two-person
 * meeting as one un-attributed blob. One shape in, one shape out.
 *
 * @param {object} args
 * @param {object} args.capture  `deserializeCapture` row (status must be finished)
 * @param {object} args.view     `mergedView()` → `{ rows, merged: { text, segments } }`
 * @returns {{ messages: Array<{content: string, meta: object}>, separated: boolean }}
 */
export function captureRoomMessages({ capture, view } = {}) {
  if (!capture) return { messages: [], separated: false };
  const chunks = Array.isArray(view?.rows) ? view.rows : [];
  const segments = Array.isArray(view?.merged?.segments) ? view.merged.segments : [];
  const clusterBySeq = new Map(chunks.map((c) => [c?.seq, c?.speaker ?? null]));

  // A human correction rewrote the text. The stored segments describe what the
  // lane heard BEFORE that rewrite, so slicing them now would attribute words
  // the person never said — and hand a colleague someone else's edit. One
  // message, no per-speaker claim (except the session declaration, which is
  // about the whole recording and survives a correction).
  if (capture.correctedAt != null || !segments.length) {
    const text = String(capture.mergedText ?? "").trim();
    if (!text) return { messages: [], separated: false };
    return {
      messages: splitLong(text).map((content) => ({ content, meta: metaFor({ capture, member: null, cluster: null }) })),
      separated: false,
    };
  }

  const groups = [];
  for (const seg of segments) {
    const text = String(seg?.text ?? "").trim();
    if (!text) continue;
    const member = seg?.speaker ?? null;
    const cluster = clusterBySeq.get(seg?.seq) ?? null;
    const last = groups[groups.length - 1];
    if (last && last.member === member) {
      last.texts.push(text);
      if (cluster) last.clusters.add(cluster);
    } else {
      groups.push({ member, texts: [text], clusters: new Set(cluster ? [cluster] : []) });
    }
  }
  if (!groups.length) return { messages: [], separated: false };

  const messages = [];
  for (const group of groups) {
    const content = joinTranscripts(group.texts);
    if (!content) continue;
    // One stream id per stretch: the person when known (a person may own two
    // clusters), otherwise the first cluster that spoke it.
    const cluster = group.member ? null : ([...group.clusters][0] ?? null);
    for (const piece of splitLong(content)) {
      messages.push({ content: piece, meta: metaFor({ capture, member: group.member, cluster }) });
    }
  }
  return { messages, separated: groups.length > 1 && groups.some((g) => g.member) };
}
