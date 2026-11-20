// routes/speaker-attribution.js — the attribution face of a capture
// (openspec: add-speaker-attribution, 5.x / 6.2 / 7.3).
//
// Three verbs and one background job:
//   GET  /api/voice/captures/:id/attributions  — the view (rows, summary, trail)
//   POST /api/voice/captures/:id/bind          — name a cluster
//   POST /api/voice/captures/:id/unbind        — take the name back
//   syncPendingAttribution()                   — queue a "who said this?" card
//
// The card goes into the EXISTING todo surface (`input_requests`), not a new
// inbox: 6.2 is explicit about that, and a second inbox is a second place people
// forget to look. Answering it there and answering it here must converge, so the
// read path reconciles: an answered card becomes a binding, once.
//
// "Who was present" is a seam (`ctx.capturePresentMembers`), not a guess. Its
// default is the capture's owner alone — a room membership source does not exist
// yet, and failing closed means a typo cannot become a standing claim about who
// said what.

import { randomUUID } from "node:crypto";
import * as db from "../../db.js";
import {
  CLUSTER_ANONYMOUS,
  CLUSTER_SESSION,
  attributionSummary,
  bindCluster,
  bindingsMap,
  deriveAttributions,
  ensureSpeakerTables,
  listAttributions,
  listBindingEvents,
  listBindings,
  unbindCluster,
  writeAttributions,
} from "../speaker-attribution.js";
import {
  createInputRequest,
  ensureInputRequestSchema,
  getInputRequest,
} from "../input-requests.js";
// Reading the stored segment array is the merge's job (3.2); the parser lives with
// the capture store so a hand-edited row is handled in exactly one place.
import { parseSegmentsJson } from "../voice-capture.js";

/** The card asking a human who spoke — a pointer, never an inference. */
function attributionCard({ capture, cluster, candidates, basis }) {
  return {
    type: "choice",
    title: "这段话是谁说的？",
    detail: `${basis}。确认后只会改动本次采集的归属，不会把这次贴名带到下一场。`,
    fields: [
      {
        key: "member",
        // `choice` cards require exactly one `enum` field (input-requests'
        // contract), and an enum needs explicit options.
        kind: "enum",
        label: "说话人",
        required: true,
        options: candidates.map((m) => ({ value: m, label: m })),
      },
    ],
    // Read back by syncPendingAttribution on the next read, so the card and the
    // attribution view cannot disagree.
    meta: { source: "speaker-attribution", captureId: capture.id, cluster },
  };
}

/**
 * Queue one "who was this?" card per anonymous cluster of a finished capture.
 *
 * Returns the number created. Idempotent per (capture, cluster) within a
 * process, and per stored card id across restarts (the id is derived from the
 * pair, so a re-run cannot create twins).
 */
export function syncPendingAttribution(ctx, { capture, rows, members = null, now = Date.now() }) {
  if (!db.isDbReady()) return { created: 0 };
  const handle = db.getDb();
  ensureInputRequestSchema(handle);

  const anonymousClusters = [...new Set(rows.filter((r) => r.certainty === "anonymous").map((r) => r.cluster))];
  if (!anonymousClusters.length) return { created: 0 };

  const candidates = members ?? ctx.capturePresentMembers?.(capture) ?? [capture.owner];
  let created = 0;
  for (const cluster of anonymousClusters) {
    const id = `spkreq_${capture.id}_${cluster}`;
    const existing = getInputRequest(handle, id);
    if (existing) continue;
    try {
      createInputRequest(handle, {
        id,
        ownerEmail: capture.owner,
        sessionId: capture.roomId ?? null,
        card: attributionCard({ capture, cluster, candidates, basis: rows.find((r) => r.cluster === cluster)?.basis ?? "" }),
        now,
      });
      created += 1;
    } catch (e) {
      // A card that cannot be created must not fail the capture: the recording
      // and its text are the user's, the confirmation is a convenience.
      console.warn(`[speaker-attribution] card for ${id} not created: ${e?.message || e}`);
    }
  }
  return { created };
}

/**
 * Adopt answers that were given on the todo surface.
 *
 * A card answered there is a real decision by a real person; ignoring it because
 * it arrived through the other door would be the "two readers of one credential"
 * bug in another costume. Run on every read; a binding written twice is a no-op
 * because the store is keyed by (capture, cluster).
 */
export function adoptCardAnswers(ctx, { capture, rows, members = null }) {
  const handle = db.getDb();
  const adopted = [];
  const candidates = members ?? ctx.capturePresentMembers?.(capture) ?? [capture.owner];
  for (const cluster of [...new Set(rows.filter((r) => r.certainty === "anonymous").map((r) => r.cluster))]) {
    const request = getInputRequest(handle, `spkreq_${capture.id}_${cluster}`);
    if (!request || request.state !== "answered") continue;
    const member = String(request.values?.member ?? "").trim().toLowerCase();
    if (!member) continue;
    const r = bindCluster(handle, {
      captureId: capture.id,
      owner: capture.owner,
      cluster,
      member,
      actor: request.answeredBy ?? capture.owner,
      allowedMembers: candidates,
    });
    if (r.ok) adopted.push({ cluster, member });
  }
  return adopted;
}

export function registerSpeakerAttributionRoutes(ctx) {
  const { app } = ctx;

  const handle = () => {
    const h = db.getDb();
    ensureSpeakerTables(h);
    return h;
  };

  const owner = (req) => req.ssoUser?.email || req.user?.email || ctx.cellUserEmail || "local-owner";

  const load = (req, res) => {
    const h = handle();
    const now = Date.now();
    const capture = requireCapture(h, req.params.id, owner(req), now);
    if (!capture) {
      res.status(404).json({ error: "采集不存在", code: "not_found" });
      return null;
    }
    return { h, capture, now };
  };

  app.get("/api/voice/captures/:id/attributions", (req, res) => {
    if (ctx.authEnabled && !req.user?.email && !ctx.cellUserEmail) {
      return res.status(401).json({ error: "Authentication is required" });
    }
    if (!db.isDbReady()) return res.status(503).json({ error: "Database not ready" });
    const loaded = load(req, res);
    if (!loaded) return;
    const { h, capture } = loaded;

    let rows = listAttributions(h, { captureId: capture.id });
    // Derive on demand if the capture was finished before attributions existed.
    if (!rows.length && capture.status === "finished") {
      rows = deriveCapture(h, capture);
    }
    const adopted = adoptCardAnswers(ctx, { capture, rows });
    if (adopted.length) rows = listAttributions(h, { captureId: capture.id });

    res.json({
      captureId: capture.id,
      speakerMode: capture.speakerMode,
      separated: attributionSummary(rows).separated,
      attributions: rows,
      bindings: listBindings(h, { captureId: capture.id }),
      events: listBindingEvents(h, { captureId: capture.id }),
      summary: attributionSummary(rows),
      adopted,
    });
  });

  app.post("/api/voice/captures/:id/bind", (req, res) => {
    if (!db.isDbReady()) return res.status(503).json({ error: "Database not ready" });
    const loaded = load(req, res);
    if (!loaded) return;
    const { h, capture, now } = loaded;
    const cluster = String(req.body?.cluster ?? "").trim();
    const member = String(req.body?.member ?? "").trim();
    if (!cluster || !member) {
      return res.status(400).json({ error: "fields `cluster` and `member` are required", code: "bad_binding" });
    }
    const members = ctx.capturePresentMembers?.(capture) ?? [capture.owner];
    const out = bindCluster(h, {
      captureId: capture.id,
      owner: capture.owner,
      cluster,
      member,
      actor: owner(req),
      allowedMembers: members,
      now,
    });
    if (!out.ok) {
      return res.status(out.code === "member_not_present" ? 409 : 400).json({
        error: out.code === "member_not_present" ? "该成员不在本次采集的在场成员内" : "无法绑定该簇",
        code: out.code,
        ...(out.detail ? { detail: out.detail } : {}),
      });
    }
    res.json({ ok: true, ...out, attributions: listAttributions(h, { captureId: capture.id }) });
  });

  app.post("/api/voice/captures/:id/unbind", (req, res) => {
    if (!db.isDbReady()) return res.status(503).json({ error: "Database not ready" });
    const loaded = load(req, res);
    if (!loaded) return;
    const { h, capture, now } = loaded;
    const cluster = String(req.body?.cluster ?? "").trim();
    if (!cluster) return res.status(400).json({ error: "field `cluster` is required", code: "bad_binding" });
    const out = unbindCluster(h, { captureId: capture.id, cluster, actor: owner(req), now });
    if (!out.ok) return res.status(409).json({ error: "该簇尚未贴名", code: out.code });
    res.json({ ok: true, ...out, attributions: listAttributions(h, { captureId: capture.id }) });
  });
}

/** Derive + persist for one capture, honoring its own speaker mode. */
export function deriveCapture(handle, capture, { now = Date.now() } = {}) {
  const chunks = handle
    .prepare(
      "SELECT seq, start_ms, start_ms AS startMs, duration_ms, duration_ms AS durationMs, end_ms, end_ms AS endMs, speaker, segments_json, text, status FROM voice_capture_chunks WHERE capture_id = ? ORDER BY seq",
    )
    .all(capture.id)
    .map((r) => ({
      seq: r.seq,
      startMs: r.start_ms,
      durationMs: r.duration_ms,
      // 3.2: the merge works per SEGMENT, so the stored label and the lane's own
      // segment array have to reach it. A row written before this change has both
      // NULL, which the merge reads as "no separation" — the pre-change answer.
      endMs: r.end_ms ?? null,
      speaker: r.speaker ?? null,
      segments: parseSegmentsJson(r.segments_json),
      text: r.text,
      status: r.status,
    }));
  const rows = deriveAttributions({
    // L0 only when the capture SAYS it was one person on their own device.
    sessionMember: capture.speakerMode === "session" ? capture.owner : null,
    chunks,
    diarization: [], // the lane returns none; see docs/voice-diarization-probe.md
    bindings: bindingsMap(handle, { captureId: capture.id }),
  });
  writeAttributions(handle, { captureId: capture.id, owner: capture.owner, rows, now });
  return listAttributions(handle, { captureId: capture.id });
}

function requireCapture(handle, id, ownerEmail, now) {
  const row = handle.prepare("SELECT * FROM voice_captures WHERE id = ? AND owner = ?").get(id, ownerEmail);
  if (!row) return null;
  if (row.status === "abandoned") return null;
  return {
    id: row.id,
    owner: row.owner,
    title: row.title,
    status: row.status === "recording" && row.expires_at <= now ? "expired" : row.status,
    roomId: row.room_id ?? null,
    speakerMode: row.speaker_mode ?? "shared",
  };
}

export const ATTRIBUTION_CLUSTERS = Object.freeze({ anonymous: CLUSTER_ANONYMOUS, session: CLUSTER_SESSION });
export const __newCardId = () => `spkreq_${randomUUID()}`;
