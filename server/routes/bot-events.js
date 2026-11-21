// Subscriber endpoint for fd-bot (adopt-fd-bot-transport 6.1).
//
// fd-bot pushes a normalized envelope here after it has persisted and acked the
// platform. Authentication is NOT the browser identity (a machine cannot hold a
// session) and NOT the per-bot webhook secret (that belongs to the old path): it
// is the binding's delivery token, which the SUBSCRIBER supplies when it creates
// the binding. Rotating fd-bot's knowledge of the subscriber therefore rotates
// this token; nothing else changes.
//
// This route is exempt from forward-auth in server/auth.js for the same reason
// the webhook prefix is — see the exemption list there.
//
// 2xx means "delivered". Anything else makes fd-bot retry with backoff, which is
// the whole point of answering honestly.

import express from "express";
import * as bots from "../bots.js";
import { secretMatches } from "../auth.js";

// Shared with the forward-auth exemption in auth.js.
export const EVENTS_PREFIX = "/api/bots/events";

const eventsToken = () => String(process.env.BOTS_EVENTS_TOKEN || "").trim();

function bearer(header) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || "").trim());
  return m ? m[1].trim() : null;
}

// Map the binding id back to a bot row. The id is stored on the row when the
// binding is created, so this is a lookup, not a derivation: two bots may share
// a platform, and guessing from `type` would deliver to the wrong one.
function botForBinding(db, bindingId) {
  try {
    return db.listBots().find((b) => b.fdBotBindingId && secretMatches(bindingId, b.fdBotBindingId)) ?? null;
  } catch {
    return null;
  }
}

export function registerBotEventRoutes(ctx) {
  const { app } = ctx;
  // Injectable for tests. Defaulting here (not at import time) keeps the
  // production binding and gives the suite a seam that does not need to reach
  // into a frozen ESM namespace.
  const runTurn = (botId, args) => (ctx.botTurnRunner ?? bots.handleMessage)(botId, args);

  app.post(EVENTS_PREFIX, express.json({ limit: "64kb" }), async (req, res) => {
    const expected = eventsToken();
    // No token configured → the route answers 404, never a weaker form of
    // itself (same rule as the relay).
    if (!expected) return res.status(404).json({ error: "not found" });
    if (!secretMatches(bearer(req.headers.authorization), expected)) {
      return res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "Invalid events token" });
    }

    const db = ctx.db;
    const envelope = req.body ?? {};
    const bindingId = String(envelope.bindingId ?? "");
    if (!bindingId) return res.status(400).json({ error: "Missing bindingId" });

    const bot = botForBinding(db, bindingId);
    if (!bot) {
      // 410 (not 404): the binding is gone from this cell's point of view and
      // retrying will not help. fd-bot marks the delivery failed, which is
      // honest, and the operator sees a binding that no longer has a consumer.
      return res.status(410).json({ error: "No bot owns this binding" });
    }
    if (!bot.enabled) return res.status(200).json({ ok: true, note: "bot disabled" });

    // The bridge takes precedence exactly as it does on the legacy path: a bot
    // bound to a room/team account hands the message to the room instead of
    // starting a per-chat agent session.
    const bridge = ctx.zhiyuImBridge;
    if (bridge && (bot.zhiRoomId || bot.zhiAccountId)) {
      const handled = await bridge
        .handleInbound({
          bot,
          chatKey: String(envelope.chatKey ?? ""),
          senderName: envelope.senderName ?? envelope.senderId ?? null,
          text: String(envelope.text ?? ""),
          imUserId: envelope.senderId ?? null,
        })
        .catch((err) => {
          console.warn(`[bot-events] bridge failed for bot "${bot.name}": ${err.message}`);
          return false;
        });
      if (handled) return res.status(200).json({ ok: true, via: "bridge" });
    }

    // Media rides as tickets in the envelope. The legacy path has no media face
    // at all (it drops non-text messages), so v1 notes them rather than
    // pretending to consume them: the operator can see a message ARRIVED with an
    // image even before the turn understands images.
    const media = Array.isArray(envelope.media) ? envelope.media.filter((m) => m?.url) : [];
    const text = String(envelope.text ?? "");
    if (!text.trim() && media.length) {
      console.warn(`[bot-events] bot "${bot.name}" got a media-only message (${media.map((m) => m.kind).join(",")}); no media consumer on this path yet`);
    }
    if (!text.trim() && !media.length) return res.status(200).json({ ok: true, note: "empty" });

    // Human-in-the-loop guard: Chatwoot's bot_handoff! moves a conversation to the
    // human queue ("pending", often still unassigned) and only later does a human
    // assign themselves ("User" assignee). In BOTH states the AI must go silent —
    // answering while a human waits to pick it up is the exact failure this stops.
    // Unassigned, or an AgentBot owner, keeps today's behaviour; a platform that
    // never sends these fields is unaffected.
    const assignee = envelope.assignee ?? null;
    if (assignee?.type === "User") {
      console.log(`[bot-events] bot "${bot.name}" skipped: conversation assigned to a human (${assignee.id})`);
      return res.status(200).json({ ok: true, note: "handed-off" });
    }
    if (envelope.conversationStatus === "pending") {
      console.log(`[bot-events] bot "${bot.name}" skipped: conversation pending in human queue`);
      return res.status(200).json({ ok: true, note: "handed-off" });
    }

    // Deliberately not awaited: fd-bot retries on a non-2xx, and an agent turn
    // that takes minutes must not hold the delivery confirmation open. A failed
    // turn is THIS cell's problem to log, not a reason to redeliver a message
    // that already reached us.
    void runTurn(bot.id, {
      chatKey: String(envelope.chatKey ?? ""),
      senderName: envelope.senderName ?? envelope.senderId ?? null,
      text,
    }).catch((err) => console.warn(`[bot-events] turn failed for bot "${bot.name}": ${err.message}`));

    return res.status(200).json({ ok: true });
  });

  // Body-parser failures answer a machine-readable 400/413 rather than 500.
  app.use(EVENTS_PREFIX, (err, _req, res, next) => {
    if (!err) return next();
    res.status(err.status === 413 ? 413 : 400).json({ error: "Malformed request body" });
  });
}
