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
import { createLaneConfig } from "./lane-config.js";

// IM lane data layer (externalize-im-platform-adapters): copy, whitelists and
// timeouts live in im-lanes.json so changing them costs no image and no restart.
const laneCfg = createLaneConfig();

const sha1 = (s) => crypto.createHash("sha1").update(s, "utf8").digest("hex");
const seatRefFor = (chatKey, imUserId) => `im_${sha1(`${chatKey}:${imUserId}`).slice(0, 12)}`;

// Rows the group is allowed to hear about. `all_passed` is here for a hard-won
// reason (2026-11-19): a broadcast round where every seat passes produced 32
// seconds of silence in the group and then NOTHING — the room knew ("本轮无人
// 作答") but the group did not, so the sender could not tell "nobody could help"
// from "the bot is broken". Silence is not an answer.
// Read per call, not once at import: the overlay is re-read on each turn, so a
// changed whitelist must take effect without a restart (externalize 2.1).
const echoEvents = () => new Set(laneCfg.get().echo.events);

export function registerZhiyuImBridge(app, { store, humanMessageHook, secret, seeder = null, maxChars = 16_000 }) {
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
    // `watermark` is the room's tail as of this read, INDEPENDENT of what the
    // filters below keep (2026-11-19). Without it the cell's cursor can only
    // advance to the last row it was SHOWN, so one unshowable row (a fleet
    // report, a filtered event) pins the cursor forever and every answer behind
    // it is stuck — observed live: cursor 138 while the room was at 144, with the
    // outbound tick silently believing there was nothing to send.
    const window = store.messagesAfter(room.id, after, { viewerMemberId: null, limit: 1000 });
    const watermark = window.reduce((m, r) => Math.max(m, Number(r.seq) || 0), after);
    const rows = window
      .filter((m) => m.visibility === "shared")
      // Both non-chat kinds reach a group: the router writes round outcomes as
      // `event` rows while the bridge writes failures as `system` rows. Filtering
      // on `kind === "system"` alone is why `all_passed` never left the gateway
      // (2026-11-19: 32s of dead air in the group).
      .filter(
        (m) =>
          m.kind === "agent" ||
          ((m.kind === "system" || m.kind === "event") && echoEvents().has(String(m.meta?.event ?? ""))),
      )
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
    res.json({ rows, watermark });
  });

  // Delivery-failure surfacing (zhiyu-im-bridge Req5): when the cell side
  // exhausts its bounded retries, the failure lands as a system event row in
  // the room's shared stream — the room sees WHY an answer never arrived in
  // the group, not a silent void. Machine credential, rate-bucketed.
  //
  // The row's CONTENT is a sentence a member or visitor can act on; the raw
  // provider error (which carries egress IPs and vendor codes) stays in
  // meta.reason for the ops surface only. Reason: 2026-11-18, 19 rows of
  // `wecom send failed: 60020 … from ip: <egress>` rendered as bare i18n keys
  // in a production room, leaking internal addressing.
  const failureSentence = (platform, seq) => {
    const where = platform ? `（${platform}）` : "";
    const which = seq ? `第 ${seq} 条回答` : "一条回答";
    return `${which}没能送到 IM 群${where}——请检查该 bot 的平台配置后重试`;
  };
  // Same cause, same chat, within a minute ⇒ one row. A cell restart clears its
  // own coalescer; this is the backstop so a restart cannot replay the stream.
  const recentFailures = new Map(); // `${chatKey}:${fingerprint}` → timestamp
  const FAILURE_DEDUPE_MS = 60_000;
  const fingerprintOf = (platform, reason) =>
    sha1(`${platform}|${String(reason ?? "").replace(/hint: \[[^\]]*\]/g, "").replace(/\d{10,}/g, "")}`).slice(0, 12);

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
    const dedupeKey = `${room.id}:${chatKey}:${fingerprintOf(platform, reason)}`;
    const now = Date.now();
    for (const [k, at] of recentFailures) if (now - at > FAILURE_DEDUPE_MS) recentFailures.delete(k);
    if ((recentFailures.get(dedupeKey) ?? 0) + FAILURE_DEDUPE_MS > now) {
      // Already surfaced this cause moments ago — acknowledged, not repeated.
      return res.json({ seq: null, deduped: true });
    }
    recentFailures.set(dedupeKey, now);
    const { row } = store.messageAppend({
      roomId: room.id,
      kind: "system",
      content: failureSentence(platform, seq),
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

  // Team-account binding face (add-zhiyu-team-account): the same machine+actor
  // trust as the room face, but the answer is about an ACCOUNT. Ownership is
  // the only thing that matters here — the cell is asking "may this actor hang
  // this team's address behind a bot?", not "what is in this room".
  app.get("/api/zhiyu/im-bridge/team-accounts/:accountId", (req, res) => {
    const actor = actorFor(req);
    if (!actor) return res.status(401).json({ error: "machine credential required" });
    const account = store.teamAccountGet(req.params.accountId);
    // Someone else's account answers exactly like a missing one.
    if (!account || account.ownerEmail !== actor.email) return res.status(404).json({ error: "not found" });
    if (account.revokedAt) return res.status(404).json({ error: "not found" });
    res.json({ id: account.id, fleetId: account.fleetId, fleetName: account.fleetName });
  });

  // Inbound ingest for an ACCOUNT-bound bot: same seat contract as the room
  // lane, but the room is resolved by the account (open-or-reuse for this IM
  // sender, exactly as the widget lane does for a web visitor). The cell sends
  // platform fields only; the seat ref and the room choice are decided here.
  app.post("/api/zhiyu/im-bridge/team-accounts/:accountId/messages", express.json({ limit: "24kb" }), async (req, res) => {
    const actor = actorFor(req);
    if (!actor) return res.status(401).json({ error: "machine credential required" });
    const account = store.teamAccountGet(req.params.accountId);
    if (!account || account.ownerEmail !== actor.email || account.revokedAt) return res.status(404).json({ error: "not found" });
    const content = String(req.body?.content ?? "").trim();
    if (!content) return res.status(400).json({ error: "content required" });
    if (content.length > maxChars) return res.status(400).json({ error: "content too long" });
    const chatKey = String(req.body?.chatKey ?? "").slice(0, 200);
    const senderName = String(req.body?.senderName ?? "群友").slice(0, 120) || "群友";
    const platform = String(req.body?.platform ?? "").slice(0, 20);
    const imUserId = String(req.body?.imUserId ?? req.body?.senderName ?? chatKey).slice(0, 200) || senderName;
    if (!take(`ingest:${account.id}:${chatKey}`, 30, 60_000)) return res.status(429).json({ error: "rate limited" });
    // One room per (account, IM chat): a group is one conversation, so the
    // chatKey is the room's identity — unlike a web visitor, whose identity is
    // a pass. Reuse a live room for this chat, else open one.
    const room = reuseOrOpen(account, `im:${chatKey}`);
    if (!room) return res.status(409).json({ error: "room unavailable" });
    // Seat the team's serving members BEFORE the human message lands, so the
    // turn router sees them as present. Awaited deliberately: a message that
    // arrives before its seats would be routed to nobody and answered by
    // nobody — the exact silence this is here to prevent.
    await seeder?.current?.seat(account, room);
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
      meta: { im: { platform, chatKey, senderName }, accountId: account.id },
    });
    void Promise.resolve(humanMessageHook({ room, member: store.memberById(member.id), message: row })).catch((err) =>
      console.error(`[zhiyu:im-bridge] router failed for ${room.id}:`, err),
    );
    res.json({ seq: row.seq, roomId: room.id, member: { ref, display: senderName } });
  });

  // Open-or-reuse for an account: a live room this account opened that already
  // carries the calling conversation's key. `key` is the chatKey namespaced by
  // kind so a web visitor and an IM group can never collide on one room.
  function reuseOrOpen(account, key) {
    const rooms = store.roomsOfAccount?.(account.id) ?? [];
    const live = rooms.find((r) => r.status === "active" && r.title === accountTitle(account, key));
    if (live) return live;
    return store.roomCreate({
      title: accountTitle(account, key),
      ownerEmail: account.ownerEmail,
      idleMinutes: account.idleMinutes ?? 15,
      replyCap: account.replyCap ?? null,
      accountId: account.id,
    });
  }

  // The title doubles as the lookup key. It is derived, never typed, so the
  // same conversation always lands on the same room without a join table.
  const accountTitle = (account, key) => `${account.fleetName || account.fleetId} · ${key}`.slice(0, 200);

}
