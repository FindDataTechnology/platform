// ── Meeting agent bridge: a LiveKit meeting's audio becomes room messages ────
//
// add-ai-native-meeting (2.1/2.2). This module is the CONTRACT half of the
// meeting agent: it does not touch WebRTC itself (an agent worker process does,
// via livekit-agents). It answers two questions the worker asks:
//
//   1. "I heard these words from this person in this meeting — put them in the
//      room."  → `ingestUtterance()`, which reuses the SAME transport rules as
//      capture-ingest (one message, one speaker, evidence required, the meeting
//      must be open, the speaker must have joined).
//   2. "The agent should speak this text in the meeting voice." → `synthesize()`,
//      which reuses the deployment TTS lane + the voice catalog's three-layer
//      resolution. The worker never holds a key.
//
// Why not let the worker talk to the platform STT/TTS directly: the worker is a
// separate process with no business holding the deployment credential, and the
// room's voice resolution (seat > post > deployment) lives here. Keeping the
// two calls here means the worker is a dumb media pump: audio in, audio out.
//
// The evidence shape is the one `capture-ingest` already validates
// (`captureEvidence`), so a meeting utterance and a phone-capture stretch land
// by the same route, with the same "one message never claims two people" rule.

import { createHash } from "node:crypto";
import { voiceCatalog, resolveVoice } from "../../server/voice-catalog.js";

/**
 * Build the capture evidence for a meeting utterance. `per_stream` because the
 * worker received this audio from ONE participant's track — that is the whole
 * point of subscribing per participant rather than mixing.
 *
 * @param {{meetingId:string, seatRef:string, streamId?:string}} args
 */
export function meetingEvidence({ meetingId, seatRef, streamId }) {
  if (!meetingId || !seatRef) return null;
  return {
    // The meeting this evidence belongs to, IN the evidence (2026-11-24).
    // The minutes builder filters on exactly this field; without it the filter
    // matched nothing and every meeting produced zero minutes.
    meetingId,
    streamId: streamId || `${meetingId}#${seatRef}`,
    mode: "per_stream",
    declaredMemberId: String(seatRef).toLowerCase(),
  };
}

/**
 * Turn one recognised utterance into the `messages[]` entry `capture-ingest`
 * accepts. Returns null when it cannot be attributed (empty text / no meeting).
 *
 * Deliberately does NOT guess a speaker: with no seat, it returns a `mixed`
 * evidence (attributed to nobody → the room asks), never a default person.
 */
export function utteranceToMessage({ meetingId, seatRef, text }) {
  const content = String(text ?? "").trim();
  if (!meetingId || !content) return null;
  const evidence = seatRef
    ? meetingEvidence({ meetingId, seatRef })
    : { streamId: `${meetingId}#mixed`, mode: "mixed" };
  return {
    content,
    capture: evidence,
    ...(seatRef ? { memberRef: String(seatRef).toLowerCase() } : {}),
  };
}

/**
 * The voice an agent utterance should use in a given meeting seat, resolved by
 * the same three-layer rule the room speech path uses. Returns a
 * `{model, voice, format}` the worker passes to the platform TTS call, or the
 * deployment default when nothing is declared.
 */
export function agentVoiceFor({ seat = null, deployment = null, catalog = voiceCatalog } = {}) {
  const r = resolveVoice({ seat, deployment }, { catalog });
  if (!r.entry) return null;
  return { model: r.entry.model, voice: r.entry.voice };
}

/** Stable cache key for one synthesis, so a repeated line is not re-sent. */
export function speechKey(text, { model, voice, format = "mp3" } = {}) {
  return createHash("sha256").update(`${text}\u0000${model}\u0000${voice}\u0000${format}`).digest("hex").slice(0, 32);
}

/**
 * Deliver ONE message with capture evidence into a room, by the one rule both
 * the phone-capture lane and the meeting-agent lane must obey (add-ai-native
 * -meeting 4.1). The two callers must never drift: the refusal semantics, the
 * sender resolution, and the "named but absent is reported, not hidden" fact all
 * live here.
 *
 * Sender resolution MUST stay `named ?? actor ?? owner`: dropping the actor
 * rung silently attributes a caller's words to the room owner.
 */
export async function deliverEvidenceMessage({
  store,
  room,
  meetingId = null,
  content,
  capture,
  memberRef = null,
  actorRef = null,
  source = "meeting",
  humanMessageHook = async () => {},
}) {
  const named = String(memberRef ?? "").trim().toLowerCase();
  const namedMember = named ? store.memberFor(room.id, "user", named) : null;
  const actorMember = actorRef ? store.memberFor(room.id, "user", String(actorRef).toLowerCase()) : null;
  const owner = store.memberFor(room.id, "user", String(room.ownerEmail ?? "").toLowerCase());
  const sender = namedMember ?? actorMember ?? owner;
  if (!sender) return { error: "room has no seat for the speaker", status: 409 };

  const { row } = store.messageAppend({
    roomId: room.id,
    kind: "human",
    senderMemberId: sender.id,
    content: String(content).trim(),
    // `meetingId` rides BOTH the top level and the capture block (2026-11-24).
    // The minutes builder filters on `capture.meetingId`, and the capture block
    // produced by meetingEvidence() only carries streamId/mode/declaredMemberId
    // — so the filter matched nothing and every meeting produced ZERO minutes
    // while every unit test (which fed hand-built rows) stayed green. A capture
    // block that describes which meeting it belongs to should say so.
    meta: {
      source,
      capture: capture && meetingId ? { ...capture, meetingId } : capture,
      ...(meetingId ? { meetingId } : {}),
    },
  });
  await humanMessageHook({ room: store.roomGet(room.id), member: store.memberById(sender.id), message: row });
  return {
    row,
    senderRef: sender.ref,
    ...(named && !namedMember ? { senderFallback: true, namedRef: named } : {}),
  };
}

/**
 * Build a meeting's minutes from the messages that already landed (add-ai-native
 * -meeting 4.3). Deliberately NOT an LLM summary: the minutes are the factual
 * record — who said what, in what order, per speaker — and inventing a prose
 * summary would be the model guessing at a private conversation. A later LLM
 * pass MAY annotate this, but the base stays deterministic and re-derivable.
 *
 * @param {{messages: Array<{seq:number, kind:string, content:string, meta:object, senderService?:string}>}} args
 * @returns {{ lines: string[], speakers: string[], count: number }}
 */
export function meetingMinutes({ messages = [] } = {}) {
  const rows = messages.filter(
    (m) => m && m.meta && m.meta.source === "meeting" && typeof m.content === "string" && m.content.trim(),
  );
  const speakers = [];
  const seen = new Set();
  const lines = [];
  for (const m of rows) {
    const who = String(m.meta.capture?.declaredMemberId ?? m.meta.capture?.seatOwnerMemberId ?? "未归属");
    if (!seen.has(who)) { seen.add(who); speakers.push(who); }
    lines.push(`${who}：${m.content.trim()}`);
  }
  return { lines, speakers, count: rows.length };
}
