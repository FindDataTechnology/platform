// ── Capture ingest: a meeting recording enters a voice room (D9's transport) ──
//
// `voice-route.js` reads `meta.capture` off a room message; nothing in the
// platform could put it there, because the capture store (platform SQLite) and
// the room store (gateway SQLite) live in two processes. This is that hop.
//
// Three properties, each one a rule this file cannot bend:
//
//   1. CAPTURE-ONLY. Every message must carry parseable evidence; a message
//      without it is refused rather than accepted as a plain human line. A
//      general-purpose "post into a room as anyone" machine face would be a
//      much larger door than this one.
//   2. ONE MESSAGE, ONE SPEAKER. The split happened upstream (each message is
//      one stretch of one person); this file does not re-merge them, because
//      re-merging is exactly how a message ends up claiming two people.
//   3. THE PERSON NAMED, NOT THE CALLER. The sender is the attributed member
//      when the room knows them; the caller's identity is only the fallback,
//      and the fallback is REPORTED (`senderFallback`) so the platform can say
//      so instead of quietly attributing a stranger's words to the operator.
//   4. A MEETING STREAM IS CHECKED AGAINST ITS MEETING. When the batch names a
//      `meetingId`, the meeting must exist in THIS room, be `open`, and every
//      message's `seatOwnerMemberId` must be a member who actually JOINED it.
//      Without this, `streamId` would be a client-side claim — and that claim is
//      the only thing the router trusts for "whose words are these".

import express from "express";
import { GATEWAY_SECRET_HEADER, secretMatches } from "../../server/auth.js";
import { captureEvidence } from "./voice-route.js";

const MAX_MESSAGES = 200;

export function registerZhiyuCaptureIngest(app, { store, humanMessageHook, secret, maxChars = 16_000 }) {
  const actorFor = (req) => {
    const provided = req.headers[GATEWAY_SECRET_HEADER];
    if (!secretMatches(provided, secret)) return null;
    const email = String(req.headers["x-actor-email"] ?? "").trim().toLowerCase();
    return email ? { email } : null;
  };

  /** The decision the router just wrote for this message, or null if it wrote none. */
  const decisionAfter = (roomId, sinceSeq) => {
    const rows = store.messagesAfter(roomId, sinceSeq, { limit: 500 });
    const row = rows.find((m) => m?.meta?.event === "route_decision");
    if (!row) return null;
    return {
      basis: row.meta.kind ?? null,
      recipients: row.meta.recipients ?? [],
      candidates: row.meta.candidates ?? [],
      reason: row.meta.reason ?? null,
    };
  };

  const maxSeqOf = (roomId) => {
    const rows = store.messagesAfter(roomId, 0, { limit: 100_000 });
    return rows.length ? Number(rows[rows.length - 1].seq ?? 0) : 0;
  };

  app.post("/api/zhiyu/capture-ingest/rooms/:id/messages", express.json({ limit: "512kb" }), async (req, res) => {
    const actor = actorFor(req);
    if (!actor) return res.status(401).json({ error: "machine credential required" });
    const room = store.roomGet(req.params.id);
    if (!room) return res.status(404).json({ error: "not found" });
    if (room.status !== "active") return res.status(409).json({ error: "room ended" });

    // Authority: the owner, or a person who is already an active member. A
    // capture is a private conversation being published — being able to reach
    // the room is the bar, and it is the same bar the human POST uses.
    const actorMember = store.memberFor(room.id, "user", actor.email);
    const isOwner = String(room.ownerEmail ?? "").toLowerCase() === actor.email;
    if (!isOwner && !actorMember) return res.status(403).json({ error: "not a member of this room" });

    const list = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!list.length) return res.status(400).json({ error: "field `messages` is required" });
    if (list.length > MAX_MESSAGES) return res.status(400).json({ error: "too many messages" });

    // Meeting streams (add-meeting-capture). Absent = the standalone path, which
    // must behave exactly as before, so nothing below runs without a meetingId.
    const meetingId = String(req.body?.meetingId ?? "").trim();
    let meeting = null;
    if (meetingId) {
      meeting = store.meetingGet(meetingId);
      if (!meeting || meeting.roomId !== room.id) {
        return res.status(404).json({ error: "meeting not found in this room", code: "meeting_not_found" });
      }
      if (meeting.status !== "open") {
        return res.status(409).json({ error: "meeting ended", code: "meeting_not_open" });
      }
      const joined = new Set(store.meetingParticipants(meeting.id).map((p) => p.memberRef));
      for (const m of list) {
        const owner = String(m?.capture?.seatOwnerMemberId ?? m?.capture?.declaredMemberId ?? "").trim();
        // A stream with no person is ALLOWED through here: it is the mixed-mic
        // case, which must land as needs_confirmation rather than be refused.
        // But when it names someone, that person must be an attendee.
        if (owner && !joined.has(owner)) {
          return res.status(409).json({
            error: "speaker has not joined this meeting",
            code: "meeting_member_not_joined",
            detail: { member: owner },
          });
        }
      }
    }

    // Validate the whole batch before writing any of it: half a meeting is not
    // a usable transcript, and a partial write is one nobody can retry cleanly.
    for (const m of list) {
      const content = String(m?.content ?? "").trim();
      if (!content) return res.status(400).json({ error: "every message needs `content`" });
      if (content.length > maxChars) return res.status(400).json({ error: "content too long" });
      if (!captureEvidence({ meta: { capture: m?.capture } })) {
        return res.status(400).json({ error: "every message needs capture evidence", code: "evidence_required" });
      }
    }

    const owner = store.memberFor(room.id, "user", String(room.ownerEmail ?? "").toLowerCase());
    const delivered = [];
    for (const m of list) {
      const content = String(m.content).trim();
      const evidence = captureEvidence({ meta: { capture: m.capture } });
      const named = String(m?.memberRef ?? "").trim().toLowerCase();
      const namedMember = named ? store.memberFor(room.id, "user", named) : null;
      const sender = namedMember ?? actorMember ?? owner;
      if (!sender) return res.status(409).json({ error: "room has no seat for the speaker" });

      const before = maxSeqOf(room.id);
      const { row } = store.messageAppend({
        roomId: room.id,
        kind: "human",
        senderMemberId: sender.id,
        content,
        meta: { source: "capture", capture: evidence, ...(meeting ? { meetingId: meeting.id } : {}) },
      });
      await humanMessageHook({ room: store.roomGet(room.id), member: store.memberById(sender.id), message: row });
      delivered.push({
        seq: row.seq,
        senderRef: sender.ref,
        // Named but absent is a fact worth reporting: the route still used the
        // evidence (the room team's owner), only the prompt's "from X" differs.
        ...(named && !namedMember ? { senderFallback: true, namedRef: named } : {}),
        decision: decisionAfter(room.id, before),
      });
    }

    res.json({ ok: true, roomId: room.id, delivered });
  });
}
