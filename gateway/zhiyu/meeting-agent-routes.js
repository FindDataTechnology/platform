// ── Meeting agent routes (add-ai-native-meeting 2.1/2.2) ─────────────────────
//
// The platform half of the meeting agent. The worker (gateway/meeting-worker)
// holds no key; these two routes do the model work with the DEPLOYMENT
// credential and reuse the room's existing rules:
//
//   POST /api/zhiyu/meetings/:id/utterance   audio → STT → room message (per_stream)
//   POST /api/zhiyu/meetings/:id/speak       text → TTS (voice catalog) → WAV bytes
//
// Both sit behind the SAME machine door as capture-ingest
// (x-cloud-gateway-secret + x-actor-email), so a meeting utterance and a phone
// capture can never disagree about who may publish into a room.
//
// Attribution is never guessed: a segment with a seatRef that is not a joined
// participant is refused; a segment with no seat lands as `mixed` (the room
// asks, nobody is named).
import express from "express";
import multer from "multer";
import { GATEWAY_SECRET_HEADER } from "../../server/auth.js";
import { cellDoorAuthorized } from "../cell-credential.js";
import { utteranceToMessage, agentVoiceFor, deliverEvidenceMessage } from "./meeting-agent.js";
import { s3PutObject } from "../../lib/s3.js";

const SEG_MAX_BYTES = 8 * 1024 * 1024; // ~2 min of 16k mono wav

export function registerMeetingAgentRoutes(app, { store, voiceForward, secret, humanMessageHook = async () => {}, recording = null }) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: SEG_MAX_BYTES } });

  const actorFor = (req) => {
    if (!cellDoorAuthorized(req.headers[GATEWAY_SECRET_HEADER], secret)) return null;
    const email = String(req.headers["x-actor-email"] ?? "").trim().toLowerCase();
    return email ? { email } : null;
  };

  // —— resolve: which LiveKit room is this meeting? (add-ai-native-meeting 3.1)
  // The worker asks THIS, not an env var: a meeting and its media room are one
  // object, so the room name comes from the meeting row. It carries the LiveKit
  // token the worker connects with — minted here, server-side, so the worker
  // still holds no API secret beyond the machine credential it already has.
  app.get("/api/zhiyu/meetings/:id/media", async (req, res) => {
    if (!actorFor(req)) return res.status(401).json({ error: "machine credential required" });
    const meeting = store.meetingGet(req.params.id);
    if (!meeting) return res.status(404).json({ error: "meeting not found" });
    if (meeting.status !== "open") return res.status(409).json({ error: "meeting ended", code: "meeting_not_open" });
    if (!meeting.livekitRoom) return res.status(409).json({ error: "no media room for this meeting", code: "no_media_room" });
    return res.json({ meetingId: meeting.id, livekitRoom: meeting.livekitRoom });
  });

  // —— to-say: what the agent should speak next (add-ai-native-meeting 2.3) ——
  // The worker polls this with a cursor; every `kind=agent` row that landed in
  // the meeting AFTER the cursor is something to speak. A machine-readable feed
  // rather than a push: the worker needs no inbound reachability and no login,
  // and a missed poll is recovered by the next one (`after` is idempotent).
  app.get("/api/zhiyu/meetings/:id/to-say", async (req, res) => {
    if (!actorFor(req)) return res.status(401).json({ error: "machine credential required" });
    const meeting = store.meetingGet(req.params.id);
    if (!meeting) return res.status(404).json({ error: "meeting not found" });
    const after = Number(req.query.after ?? 0) || 0;
    const rows = store.messagesAfter(meeting.roomId, after, { limit: 200 })
      .filter((m) => m.kind === "agent" && typeof m.content === "string" && m.content.trim());
    return res.json({
      cursor: rows.length ? rows[rows.length - 1].seq : after,
      items: rows.map((m) => ({ seq: m.seq, text: m.content.trim(), memberId: m.senderMemberId ?? null })),
    });
  });

  // —— hear: audio segment → transcribed room message ——————————————————————
  app.post("/api/zhiyu/meetings/:id/utterance", upload.single("audio"), async (req, res) => {
    if (!actorFor(req)) return res.status(401).json({ error: "machine credential required" });
    const meeting = store.meetingGet(req.params.id);
    if (!meeting) return res.status(404).json({ error: "meeting not found" });
    if (meeting.status !== "open") return res.status(409).json({ error: "meeting ended", code: "meeting_not_open" });
    if (!req.file?.buffer?.length) return res.status(400).json({ error: "field `audio` is required" });

    const seatRef = String(req.body?.seatRef ?? "").trim().toLowerCase();
    // A named speaker MUST have joined this meeting — the same rule capture-ingest
    // enforces. Not joined = refused, not silently attributed to someone.
    if (seatRef) {
      const joined = store.meetingParticipants(meeting.id).map((p) => String(p.memberRef).toLowerCase());
      if (!joined.includes(seatRef)) {
        return res.status(409).json({ error: "speaker has not joined this meeting", code: "meeting_member_not_joined" });
      }
    }

    const out = await voiceForward.transcribe({ buffer: req.file.buffer, mime: req.file.mimetype || "audio/wav", filename: req.file.originalname || "segment.wav" });
    if (!out.ok) return res.status(out.status).json(out.body);
    const text = String(out.text ?? "").trim();
    if (!text) return res.json({ ok: true, delivered: [], reason: "empty_transcript" });

    const msg = utteranceToMessage({ meetingId: meeting.id, seatRef: seatRef || null, text });
    const room = store.roomGet(meeting.roomId);
    if (!room) return res.status(404).json({ error: "room not found" });
    const delivered = await deliverEvidenceMessage({
      store, room, meetingId: meeting.id, content: msg.content, capture: msg.capture, memberRef: seatRef || null, humanMessageHook,
    });
    if (delivered.error) return res.status(delivered.status).json({ error: delivered.error });
    res.json({
      ok: true,
      delivered: [{ seq: delivered.row.seq, senderRef: delivered.senderRef, ...(delivered.senderFallback ? { senderFallback: true, namedRef: delivered.namedRef } : {}) }],
    });
  });

  // —— speak: text → TTS audio (WAV), voice from the catalog's three layers ——
  app.post("/api/zhiyu/meetings/:id/speak", express.json({ limit: "16kb" }), async (req, res) => {
    if (!actorFor(req)) return res.status(401).json({ error: "machine credential required" });
    const meeting = store.meetingGet(req.params.id);
    if (!meeting) return res.status(404).json({ error: "meeting not found" });
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "field `text` is required" });

    const seatRef = String(req.body?.seatRef ?? "").trim().toLowerCase();
    const seat = seatRef ? store.memberFor(meeting.roomId, "user", seatRef) : null;
    const cfg = voiceForward.config();
    const voice = agentVoiceFor({
      seat: seat?.voice ?? null,
      deployment: cfg.ttsModel && cfg.ttsVoice ? { model: cfg.ttsModel, voice: cfg.ttsVoice } : null,
    });
    if (!voice) return res.status(503).json({ error: "no voice available", code: "voice_unavailable" });

    const out = await voiceForward.speak({ text, model: voice.model, voice: voice.voice, format: "wav" });
    if (!out.ok) return res.status(out.status).json(out.body);
    res.setHeader("content-type", out.contentType || "audio/wav");
    res.setHeader("x-voice-used", `${voice.model}:${voice.voice}`);
    res.send(out.audio);
  });

  // ── Record one audio segment (add-ai-native-meeting 4.2) ───────────────────
  //
  // The worker hears every participant's audio already (that is how transcripts
  // happen). Recording is the same frames, kept: it posts a bounded WAV segment
  // per speaker and THIS process writes the object, so the process that touches
  // media never holds a storage credential.
  //
  // WHY SEGMENTS AND NOT ONE FILE PER MEETING:
  // a WAV header carries its own length, so a single growing file would need
  // rewriting the header on every append (or be unplayable until the call ends).
  // Segments are each immediately valid, survive a worker crash, and upload as
  // they close — which also keeps memory flat on a long meeting.
  //
  // Attribution is by SEAT, and the seat must have joined: the same rule
  // `/utterance` enforces. A recording names a person, so getting it wrong is
  // worse than not recording at all.
  app.post("/api/zhiyu/meetings/:id/recording", upload.single("audio"), async (req, res) => {
    const actor = actorFor(req);
    if (!actor) return res.status(401).json({ error: "machine credential required" });
    if (!recording) return res.status(409).json({ error: "recording is not enabled", code: "recording_disabled" });
    const meeting = store.meetingGet(req.params.id);
    if (!meeting) return res.status(404).json({ error: "meeting not found" });
    if (!req.file?.buffer?.length) return res.status(400).json({ error: "field `audio` is required" });

    const seatRef = String(req.body?.seatRef ?? "").trim().toLowerCase();
    if (!seatRef) return res.status(400).json({ error: "field `seatRef` is required — a recording must name a speaker" });
    const joined = store.meetingParticipants(meeting.id).map((p) => String(p.memberRef).toLowerCase());
    if (!joined.includes(seatRef)) {
      return res.status(409).json({ error: "speaker has not joined this meeting", code: "meeting_member_not_joined" });
    }

    // The object key states who and when. `seq` disambiguates two segments that
    // land in the same second (short utterances back to back).
    const seq = Number(req.body?.seq) || 0;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const key = `mtg-${meeting.id}/${seatRef}/${stamp}-${String(seq).padStart(4, "0")}.wav`;

    const wrote = await s3PutObject({
      ...recording,
      key,
      body: req.file.buffer,
      contentType: "audio/wav",
    });
    if (!wrote.ok) {
      // Loud, and NOT swallowed: an unwritten recording is data loss, and the
      // worker must know so it can retry rather than move on.
      console.error(`[zhiyu] recording upload failed for ${meeting.id}/${seatRef}: ${wrote.status} ${wrote.error || ""}`);
      return res.status(502).json({ error: "storage write failed", status: wrote.status });
    }

    const seconds = Number(req.body?.durationMs) || 0;
    const list = store.meetingRecordingAppend(meeting.id, {
      memberRef: seatRef,
      key,
      bytes: req.file.buffer.length,
      durationMs: seconds,
    });
    res.json({ ok: true, key, segments: Array.isArray(list) ? list.length : null });
  });
}
