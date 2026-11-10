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

  app.get("/api/zhiyu-im-bridge/bots/:botId/room", (req, res) => {
    const email = emailOf(req);
    if (!email) return res.status(401).json({ error: "sign-in required" });
    const bot = botKnown(req.params.botId);
    if (!bot) return res.status(404).json({ error: "not found" });
    res.json({ botId: bot.id, name: bot.name, zhiRoomId: bot.zhiRoomId ?? null, enabled: bot.enabled });
  });

  app.put("/api/zhiyu-im-bridge/bots/:botId/room", express.json({ limit: "8kb" }), async (req, res) => {
    const email = emailOf(req);
    if (!email) return res.status(401).json({ error: "sign-in required" });
    const bot = botKnown(req.params.botId);
    if (!bot) return res.status(404).json({ error: "not found" });
    const roomId = String(req.body?.zhiRoomId ?? "").trim();
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
      const updated = ctx.db.updateBot(bot.id, { zhiRoomId: roomId });
      // The inbound hook reads the binding off the RUNNING bot entry, not the
      // row: without the reload a fresh binding would only take effect at the
      // next boot (the runtime entry is built there).
      if (updated) reloadBot(updated);
      console.log(`[zhiyu-im-bridge] bot "${bot.name}" bound to room ${roomId} by ${email}`);
      res.json({ botId: bot.id, zhiRoomId: roomId, room });
    } catch (err) {
      return res.status(502).json({ error: `gateway unreachable: ${err.message}` });
    }
  });

  app.delete("/api/zhiyu-im-bridge/bots/:botId/room", (req, res) => {
    const email = emailOf(req);
    if (!email) return res.status(401).json({ error: "sign-in required" });
    const bot = botKnown(req.params.botId);
    if (!bot) return res.status(404).json({ error: "not found" });
    const updated = ctx.db.updateBot(bot.id, { zhiRoomId: null });
    if (updated) reloadBot(updated);
    console.log(`[zhiyu-im-bridge] bot "${bot.name}" unbound by ${email}`);
    res.json({ ok: true });
  });
}
