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

  app.post([EVENTS_PREFIX, `${EVENTS_PREFIX}/:bindingId`], express.json({ limit: "64kb" }), async (req, res) => {
    const expected = eventsToken();
    // No token configured → the route answers 404, never a weaker form of
    // itself (same rule as the relay).
    if (!expected) return res.status(404).json({ error: "not found" });
    if (!secretMatches(bearer(req.headers.authorization), expected)) {
      return res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "Invalid events token" });
    }

    const db = ctx.db;
    const envelope = req.body ?? {};
    // A path id (when a deployment points the subscriber URL at it) is the
    // authority; the body field is the contract fd-bot ships today.
    const bindingId = String(req.params.bindingId ?? envelope.bindingId ?? "");
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
      let handled;
      try {
        handled = await bridge.handleInbound({
          bot,
          chatKey: String(envelope.chatKey ?? ""),
          senderName: envelope.senderName ?? envelope.senderId ?? null,
          text: String(envelope.text ?? ""),
          imUserId: envelope.senderId ?? null,
        });
      } catch (err) {
        // A retryable bridge failure (gateway/cell not reachable yet — cold
        // start, restart) MUST NOT 200: falling through to runTurn on a cold cell
        // is a no-op and the message is lost, while fd-bot already marked it
        // delivered. Answer 503 so fd-bot re-delivers once the cell is up.
        if (err?.retryable) {
          console.warn(`[bot-events] bot "${bot.name}" bridge temporarily unavailable, asking fd-bot to retry: ${err.message}`);
          return res.status(503).json({ error: "bridge temporarily unavailable" });
        }
        console.warn(`[bot-events] bridge failed for bot "${bot.name}": ${err.message}`);
        handled = false;
      }
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

    // Human-in-the-loop guard: the AI must go silent exactly when a HUMAN owns
    // the conversation. The ONLY trustworthy signal for that is the assignee:
    // Chatwoot's `assignee_type` returns the AI when ai_assignee is set, and
    // "User" when a person is assigned (conversation.rb:224). Once assigned,
    // `assignee_id` stays set even across resolve→reopen, so this one condition
    // also covers "a human took over, the conversation was resolved, the visitor
    // came back" — where an AI must NOT grab the conversation again.
    //
    // It must NOT be `conversationStatus === "pending"` (the bug this change
    // fixed): on a bot inbox Chatwoot writes `pending` on EVERY new conversation
    // (set_active_bot_conversation) and bot_handoff! only fires FROM pending —
    // pending means "the AI is serving", so gating on it silenced the AI on
    // every first message. Verified 2026-11-23 against the live 4.19.0 source,
    // the conversations table, and a replay through fd-bot's parseCallback.
    const assignee = envelope.assignee ?? null;
    if (assignee?.type === "User") {
      console.log(`[bot-events] bot "${bot.name}" skipped: conversation assigned to a human (${assignee.id})`);
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
