// Zhiyu IM bridge management REST, cell side (add-zhiyu-im-bridge).
//
// GET/PUT/DELETE /api/zhiyu-im-bridge/bots/:botId/room — the binding lives in
// the cell because the bot row (and its credentials) do. Room validity is
// proven through the gateway's /api/zhiyu/im-bridge/rooms/:id machine face
// (secret-shared), which itself checks the actor's access to the room.
// Foreign/unknown reading answers the same 404: never a leak of what exists.

import express from "express";
import { GATEWAY_SECRET_HEADER } from "../auth.js";
import { reload as reloadBot } from "../bots.js";
import { outboundCapabilityOfBot } from "../bots/adapter.js";
import { hasLiveResponseWindow } from "../bots/wecom-bot.js";
import { fetchWithTimeout } from "../../lib/fetch-with-timeout.js";

export function registerZhiyuImBridgeRoutes(ctx) {
  const { app } = ctx;
  const gatewayBase = () => (process.env.GATEWAY_INTERNAL_URL || `http://127.0.0.1:${process.env.GATEWAY_PORT || 3080}`).replace(/\/+$/, "");
  const secret = () => process.env.CELL_GATEWAY_SECRET || "";

  const emailOf = (req) => (ctx.authEnabled ? req.user?.email ?? null : req.user?.email ?? null);
  const machineHeaders = (email) => ({
    [GATEWAY_SECRET_HEADER]: secret(),
    "x-actor-email": email || "",
  });

  const botKnown = (id) => {
    try {
      return ctx.db.getBot(id);
    } catch {
      return null;
    }
  };

  // Binding status. `roomLive` is asked, never inferred: a room can be deleted
  // out from under a binding (there is no delete API; production did it by
  // editing sqlite), and a binding that points at nothing still LOOKS bound.
  //
  // Tri-state on purpose. "unknown" is a first-class answer: when the gateway
  // cannot be reached we do not know, and reporting "失效" there would prompt an
  // operator to unbind a bot that is working fine. A false invalidation is
  // worse than an honest unknown.
  //
  // `outbound` answers a DIFFERENT question (make-im-lane-outbound-capable):
  // can this leg deliver at all, right now? 2026-11-18 production had a bound
  // room, a live room, and 19 undelivered answers — "bound and alive" never
  // implied "can deliver", and the panel never said so.
  const outboundStateFor = (bot) => {
    const cap = outboundCapabilityOfBot(bot);
    let canSendNow = cap.mode === "url-keyed" || cap.mode === "proactive-ip-gated";
    let detail = null;
    if (cap.mode === "passive-window") {
      // Ask the SAME window table the sender consults — a second opinion here
      // would drift from what sendText actually does.
      const chats = (() => {
        try {
          return ctx.db.listBotChats().filter((c) => c.botId === bot.id && c.chatKey);
        } catch {
          return [];
        }
      })();
      canSendNow = chats.some((c) => hasLiveResponseWindow(String(c.chatKey)));
      detail = canSendNow ? "reply-window-open" : "reply-window-closed";
    } else if (cap.mode === "proactive-ip-gated") {
      detail = "egress-must-be-allowlisted";
    } else if (cap.mode === "none") {
      canSendNow = false;
      detail = "no-outbound-path";
    }
    return { mode: cap.mode, inbound: cap.inbound, canSendNow, detail };
  };

  app.get("/api/zhiyu-im-bridge/bots/:botId/room", async (req, res) => {
    const email = emailOf(req);
    if (!email) return res.status(401).json({ error: "sign-in required" });
    const bot = botKnown(req.params.botId);
    if (!bot) return res.status(404).json({ error: "not found" });
    const zhiRoomId = bot.zhiRoomId ?? null;
    let roomLive = null;
    if (zhiRoomId) {
      try {
        const r = await fetchWithTimeout(`${gatewayBase()}/api/zhiyu/im-bridge/rooms/${encodeURIComponent(zhiRoomId)}`, {
          headers: machineHeaders(email),
        });
        if (r.ok) roomLive = true;
        else if (r.status === 404 || r.status === 401) roomLive = false;
        else roomLive = "unknown";
      } catch {
        roomLive = "unknown";
      }
    }
    res.json({
      botId: bot.id,
      name: bot.name,
      zhiRoomId,
      enabled: bot.enabled,
      roomLive,
      outbound: outboundStateFor(bot),
    });
  });

  app.put("/api/zhiyu-im-bridge/bots/:botId/room", express.json({ limit: "8kb" }), async (req, res) => {
    const email = emailOf(req);
    if (!email) return res.status(401).json({ error: "sign-in required" });
    const bot = botKnown(req.params.botId);
    if (!bot) return res.status(404).json({ error: "not found" });
    const roomId = String(req.body?.zhiRoomId ?? "").trim();
    const accountId = String(req.body?.zhiAccountId ?? "").trim();
    // Two bindings, one meaning (add-zhiyu-team-account). Sending both is a
    // client error, not "last one wins": silently picking one would leave the
    // operator believing the other took effect.
    if (roomId && accountId) {
      return res.status(400).json({ error: "bind either a room or a team account, not both" });
    }
    if (accountId) {
      if (!/^fd_[0-9a-f]+$/.test(accountId) || accountId.length > 64) {
        return res.status(400).json({ error: "zhiAccountId must look like a team account id" });
      }
      try {
        // Ownership + liveness are proven at the gateway (the account table
        // lives there, and so does the actor check).
        const r = await fetchWithTimeout(`${gatewayBase()}/api/zhiyu/im-bridge/team-accounts/${encodeURIComponent(accountId)}`, {
          headers: machineHeaders(email),
        });
        if (!r.ok) return res.status(r.status === 404 || r.status === 401 ? 404 : 502).json({ error: "team account unavailable" });
        const account = await r.json();
        // Binding an account CLEARS any room binding — they are mutually
        // exclusive in the row, and a leftover room id would make the inbound
        // hook take the wrong branch.
        const updated = ctx.db.updateBot(bot.id, { zhiAccountId: accountId, zhiRoomId: null });
        if (updated) reloadBot(updated);
        console.log(`[zhiyu-im-bridge] bot "${bot.name}" bound to team account ${accountId} by ${email}`);
        return res.json({ botId: bot.id, zhiAccountId: accountId, zhiRoomId: null, account });
      } catch (err) {
        return res.status(502).json({ error: `gateway unreachable: ${err.message}` });
      }
    }
    if (!roomId || roomId.length > 64 || !/^zy_[0-9a-f]+$/.test(roomId)) {
      return res.status(400).json({ error: "zhiRoomId must look like a room id" });
    }
    try {
      // Outbound call discipline: shared deadline wrapper (default env bound)
      // — the loopback room check answers within the bound or the binding
      // degrades to a 502 instead of hanging the PUT.
      const r = await fetchWithTimeout(`${gatewayBase()}/api/zhiyu/im-bridge/rooms/${encodeURIComponent(roomId)}`, { headers: machineHeaders(email) });
      if (!r.ok) return res.status(r.status === 404 || r.status === 401 ? 404 : 502).json({ error: "room unavailable" });
      const room = await r.json();
      // Binding a room clears any account binding (mutual exclusivity, same
      // reason in reverse).
      // Outbound leg (make-im-lane-outbound-capable 3.2): optional, and it MUST be
      // one of the caller's own bots with a real outbound path. Sending through
      // someone else's bot would attribute answers to a credential the caller
      // does not own; a leg with mode "none" would bind a room to a bot that
      // cannot deliver — the exact silent failure this change exists for.
      let outboundBotId = bot.zhiOutboundBotId ?? null;
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, "outboundBotId")) {
        const requested = String(req.body.outboundBotId ?? "").trim();
        if (!requested) {
          outboundBotId = null; // explicit clear: back to "same leg as inbound"
        } else {
          const out = botKnown(requested);
          // Foreign and unknown are the same 404 — never leak what exists.
          if (!out || (out.ownerEmail && email && out.ownerEmail.toLowerCase() !== email.toLowerCase())) {
            return res.status(404).json({ error: "not found" });
          }
          if (out.id === bot.id) {
            return res.status(400).json({ error: "outbound leg must be a different bot (omit it to use the same leg)" });
          }
          const cap = outboundCapabilityOfBot(out);
          if (cap.mode === "none") return res.status(400).json({ error: "that bot has no outbound path" });
          outboundBotId = out.id;
        }
      }
      const updated = ctx.db.updateBot(bot.id, { zhiRoomId: roomId, zhiAccountId: null, zhiOutboundBotId: outboundBotId });
      // Bind starts at "now" (make-im-lane-outbound-capable 5.1). Without this,
      // the outbound tick resumes from whatever cursor this bot last held and
      // replays the room's ENTIRE history into the group — observed 2026-11-18
      // on a rebind (cursor 41, room tail 94: 53 answers vomited at the group,
      // each one failing).
      //
      // Aligning to the tail (a fact) rather than to a timestamp (a guess) keeps
      // this correct across clock skew. Best-effort: if the tail cannot be read,
      // the monotonic write guard in tickBot is the second line of defence.
      try {
        const tailRes = await fetchWithTimeout(
          `${gatewayBase()}/api/zhiyu/im-bridge/rooms/${encodeURIComponent(roomId)}/events?after=0`,
          { headers: machineHeaders(email) },
        );
        if (tailRes.ok) {
          const { rows: tailRows = [] } = await tailRes.json().catch(() => ({ rows: [] }));
          const tailSeq = tailRows.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0);
          if (tailSeq > 0 && typeof ctx.db.setBotBridgeCursor === "function") {
            ctx.db.setBotBridgeCursor(bot.id, tailSeq);
          }
        }
      } catch (err) {
        console.warn(`[zhiyu-im-bridge] could not align cursor for "${bot.name}" to the room tail: ${err.message}`);
      }
      // The inbound hook reads the binding off the RUNNING bot entry, not the
      // row: without the reload a fresh binding would only take effect at the
      // next boot (the runtime entry is built there).
      if (updated) reloadBot(updated);
      console.log(`[zhiyu-im-bridge] bot "${bot.name}" bound to room ${roomId}${outboundBotId ? ` (outbound via ${outboundBotId})` : ""} by ${email}`);
      res.json({ botId: bot.id, zhiRoomId: roomId, zhiAccountId: null, zhiOutboundBotId: outboundBotId, room });
    } catch (err) {
      return res.status(502).json({ error: `gateway unreachable: ${err.message}` });
    }
  });

  app.delete("/api/zhiyu-im-bridge/bots/:botId/room", (req, res) => {
    const email = emailOf(req);
    if (!email) return res.status(401).json({ error: "sign-in required" });
    const bot = botKnown(req.params.botId);
    if (!bot) return res.status(404).json({ error: "not found" });
    const updated = ctx.db.updateBot(bot.id, { zhiRoomId: null, zhiAccountId: null });
    if (updated) reloadBot(updated);
    console.log(`[zhiyu-im-bridge] bot "${bot.name}" unbound by ${email}`);
    res.json({ ok: true });
  });
}
