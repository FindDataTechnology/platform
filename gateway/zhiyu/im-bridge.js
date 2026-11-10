// ── Zhiyu IM bridge, gateway half (add-zhiyu-im-bridge, design D-A/D-C) ─────
//
// Machine-only lanes for the cell's bridge: inbound ingest (an IM group
// message becomes a room human message under a guest seat keyed by
// sha1(chatKey:imUserId)) and the outbound read face (a bot-scoped replay of
// the room's answer stream). Binding management itself lives cell-side next
// to the bot rows; this file never holds bot credentials and needs no
// session — the secret+actor pair is trusted (same pattern as /api/roles/self).

import crypto from "node:crypto";
import express from "express";
import { GATEWAY_SECRET_HEADER, secretMatches } from "../../server/auth.js";

const sha1 = (s) => crypto.createHash("sha1").update(s, "utf8").digest("hex");
const seatRefFor = (chatKey, imUserId) => `im_${sha1(`${chatKey}:${imUserId}`).slice(0, 12)}`;

const ECHO_EVENTS = new Set(["room_ended", "budget_exhausted", "needs_you"]);

export function registerZhiyuImBridge(app, { store, humanMessageHook, secret, maxChars = 16_000 }) {
  const actorFor = (req) => {
    const provided = req.headers[GATEWAY_SECRET_HEADER];
    if (!secretMatches(provided, secret)) return null;
    const email = String(req.headers["x-actor-email"] ?? "").trim().toLowerCase();
    return email ? { email } : null;
  };

  const bucket = new Map();
  const take = (key, limit, windowMs) => {
    const now = Date.now();
    const b = bucket.get(key) ?? { n: limit, at: now };
    if (now - b.at >= windowMs) {
      b.n = limit;
      b.at = now;
    }
    if (b.n <= 0) return false;
    b.n -= 1;
    bucket.set(key, b);
    return true;
  };

  // Inbound ingest: an IM group message becomes a room human message. The
  // seat contract lives HERE (server decides the ref) so clients pass plain
  // platform fields, never a precomputed identity.
  app.post("/api/zhiyu/im-bridge/rooms/:id/messages", express.json({ limit: "24kb" }), (req, res) => {
    const actor = actorFor(req);
    if (!actor) return res.status(401).json({ error: "machine credential required" });
    const room = store.roomGet(req.params.id);
    if (!room) return res.status(404).json({ error: "not found" });
    if (room.status !== "active") return res.status(409).json({ error: "room ended" });
    const content = String(req.body?.content ?? "").trim();
    if (!content) return res.status(400).json({ error: "content required" });
    if (content.length > maxChars) return res.status(400).json({ error: "content too long" });
    const chatKey = String(req.body?.chatKey ?? "").slice(0, 200);
    const senderName = String(req.body?.senderName ?? "群友").slice(0, 120) || "群友";
    const platform = String(req.body?.platform ?? "").slice(0, 20);
    const imUserId = String(req.body?.imUserId ?? req.body?.senderName ?? chatKey).slice(0, 200) || senderName;
    if (!take(`ingest:${room.id}:${chatKey}`, 30, 60_000)) return res.status(429).json({ error: "rate limited" });
    const ref = seatRefFor(chatKey, imUserId);
    const member = store.memberEnsure({
      roomId: room.id,
      kind: "guest",
      ref,
      display: senderName,
      historyGrant: "join_from",
      invitedBy: `im:${platform}`,
    });
    if (member.state !== "active") store.memberSetState(member.id, "active");
    const { row } = store.messageAppend({
      roomId: room.id,
      kind: "human",
      senderMemberId: member.id,
      content,
      meta: { im: { platform, chatKey, senderName } },
    });
    void Promise.resolve(humanMessageHook({ room, member: store.memberById(member.id), message: row })).catch((err) =>
      console.error(`[zhiyu:im-bridge] router failed for ${room.id}:`, err),
    );
    res.json({ seq: row.seq, member: { ref, display: senderName } });
  });

  // Outbound read face: bot-scoped replay of the room's answer stream. Rows
  // the bridge itself pushed into the room (meta.im) are excluded, echoing is
  // impossible by construction.
  app.get("/api/zhiyu/im-bridge/rooms/:id/events", (req, res) => {
    const actor = actorFor(req);
    if (!actor) return res.status(401).json({ error: "machine credential required" });
    const room = store.roomGet(req.params.id);
    if (!room) return res.status(404).json({ error: "not found" });
    const after = Number(req.query.after ?? 0) || 0;
    const members = new Map(store.membersOf(room.id).map((m) => [m.id, m]));
    const rows = store
      .messagesAfter(room.id, after, { viewerMemberId: null, limit: 1000 })
      .filter((m) => m.visibility === "shared")
      .filter((m) => m.kind === "agent" || (m.kind === "system" && ECHO_EVENTS.has(String(m.meta?.event ?? ""))))
      .filter((m) => !(m.meta && typeof m.meta === "object" && m.meta.im))
      .map((m) => {
        const sender = m.senderMemberId ? members.get(m.senderMemberId) : null;
        return {
          seq: m.seq,
          kind: m.kind,
          content: m.content,
          meta: m.meta ?? null,
          sender: sender ? { display: sender.display || sender.ref, kind: sender.kind, onBehalfOf: sender.onBehalfOf ?? null } : null,
        };
      });
    res.json({ rows });
  });

  // Delivery-failure surfacing (zhiyu-im-bridge Req5): when the cell side
  // exhausts its bounded retries, the failure lands as a system event row in
  // the room's shared stream — the room sees WHY an answer never arrived in
  // the group, not a silent void. Machine credential, rate-bucketed.
  app.post("/api/zhiyu/im-bridge/rooms/:id/delivery-failed", express.json({ limit: "4kb" }), (req, res) => {
    const actor = actorFor(req);
    if (!actor) return res.status(401).json({ error: "machine credential required" });
    const room = store.roomGet(req.params.id);
    if (!room) return res.status(404).json({ error: "not found" });
    if (room.status !== "active") return res.status(409).json({ error: "room ended" });
    if (!take(`delivery-fail:${room.id}`, 10, 60_000)) return res.status(429).json({ error: "rate limited" });
    const platform = String(req.body?.platform ?? "").slice(0, 20);
    const chatKey = String(req.body?.chatKey ?? "").slice(0, 200);
    const reason = String(req.body?.reason ?? "unknown").slice(0, 200);
    const seq = Number(req.body?.seq) || null;
    const { row } = store.messageAppend({
      roomId: room.id,
      kind: "system",
      content: "",
      meta: { event: "im_delivery_failed", platform, chatKey, seq, reason },
    });
    res.json({ seq: row.seq });
  });

  // Room binding face for the CELL's management REST: it authenticates like
  // the rest (machine+actor), checks the actor's own access to the room
  // (owner or active member), and returns the room's bindable shape.
  app.get("/api/zhiyu/im-bridge/rooms/:id", (req, res) => {
    const actor = actorFor(req);
    if (!actor) return res.status(401).json({ error: "machine credential required" });
    const room = store.roomGet(req.params.id);
    if (!room) return res.status(404).json({ error: "not found" });
    const members = store.membersOf(room.id);
    const allowed =
      room.ownerEmail === actor.email ||
      members.some((m) => m.kind === "user" && m.ref === actor.email && m.state === "active");
    if (!allowed) return res.status(404).json({ error: "not found" });
    res.json({ id: room.id, title: room.title, status: room.status });
  });
}
