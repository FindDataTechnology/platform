// Bot management + inbound webhook routes.
//
// TRUST BOUNDARY (design D3, spec "Webhook authentication under forward auth"):
// `/api/bots/webhook/*` is the ONLY route in this file exempt from the
// forward-auth identity header — external chat platforms cannot send
// X-Forwarded-Email. It authenticates on the per-bot path secret plus the
// platform's own signature/decryption instead, both of which run before any
// payload content is parsed or logged. The exemption is applied by an explicit
// path check in server/auth.js, not a blanket public flag. Every other route
// here stays behind the proxy and is admin-gated.

import express from "express";
import crypto from "node:crypto";
import * as bots from "../bots.js";
import { BOT_TYPES, credentialFieldsFor, qrCapabilityFor, getAdapter } from "../bots/adapter.js";
import { qrSvg } from "../bots/qr.js";

// The webhook path prefix, shared with the forward-auth exemption in auth.js.
export const WEBHOOK_PREFIX = "/api/bots/webhook/";

export function registerBotRoutes(ctx) {
  const { app, db } = ctx;

  const requireDb = (res) => {
    if (db.isDbReady()) return true;
    res.status(503).json({ error: "Bot management is disabled (database unavailable)" });
    return false;
  };

  // ── Inbound webhook ────────────────────────────────────────────────────────
  // Raw body: WeCom/WeChat send XML and every platform signs the bytes as sent,
  // so the payload must not be re-serialized by express.json() before checking.
  app.all(
    `${WEBHOOK_PREFIX}:botId/:secret`,
    express.raw({ type: "*/*", limit: "1mb" }),
    async (req, res) => {
      const entry = bots.getEntry(req.params.botId);
      // Same 403 for unknown bot, disabled bot, and bad secret: an attacker
      // learns nothing about which bot ids exist. timingSafeEqual guards the
      // secret compare; unequal lengths are a mismatch by definition.
      const secret = entry ? Buffer.from(entry.bot.secret) : null;
      const given = Buffer.from(String(req.params.secret));
      const ok =
        entry?.bot.enabled &&
        secret.length === given.length &&
        crypto.timingSafeEqual(secret, given);
      if (!ok) return res.sendStatus(403);

      const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
      let json;
      try { json = JSON.parse(raw); } catch { /* XML platforms: adapters read .raw */ }
      const adapterReq = { method: req.method, query: req.query, headers: req.headers, raw, json };

      // Platform verification. A throw here means the request is forged or
      // undecryptable — 403, and the content is never logged (design D3.1).
      let challenge;
      try {
        challenge = await entry.adapter.verifyWebhook(adapterReq, entry.bot.credentials);
      } catch (err) {
        console.warn(`[bots] "${entry.bot.name}" rejected an unverified webhook request: ${err.message}`);
        return res.sendStatus(403);
      }
      // The platform's URL-verification handshake wants its literal echo.
      if (challenge !== null) return res.type("text/plain").send(challenge);

      let message;
      try {
        message = await entry.adapter.parseMessage(adapterReq, entry.bot.credentials);
      } catch (err) {
        console.warn(`[bots] "${entry.bot.name}" could not parse a verified payload: ${err.message}`);
        return res.sendStatus(400);
      }

      // Ack immediately: every one of these platforms retries on a slow reply,
      // and an agent turn takes far longer than their timeout.
      res.type("text/plain").send("success");
      if (message) {
        bots.handleMessage(entry.bot.id, message).catch((e) =>
          console.warn(`[bots] "${entry.bot.name}" turn failed: ${e.message}`),
        );
      }
    },
  );

  // ── Config CRUD (admin-gated; credentials masked in every response) ────────

  app.get("/api/bots", (req, res) => {
    if (!requireDb(res)) return;
    res.json({
      bots: db.listBots().map(bots.maskBot),
      types: BOT_TYPES.map((type) => ({
        type,
        credentialFields: credentialFieldsFor(type),
        qr: qrCapabilityFor(type),
      })),
    });
  });

  app.post("/api/bots", (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    const { type, name, credentials, enabled = true } = req.body || {};
    if (!type || !name) return res.status(400).json({ error: "Missing type or name" });
    const invalid = bots.validateCredentials(type, credentials);
    if (invalid) return res.status(400).json({ error: invalid });
    const bot = db.addBot({
      id: crypto.randomUUID(),
      type,
      name,
      credentials,
      // The webhook path secret; random per bot, never rotated in place (delete
      // and recreate to rotate — the platform's callback URL must change too).
      secret: crypto.randomBytes(24).toString("base64url"),
      enabled,
    });
    bots.reload(bot);
    res.json(bots.maskBot(bot));
  });

  app.patch("/api/bots/:id", (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    const existing = db.getBot(req.params.id);
    if (!existing) return res.status(404).json({ error: "Bot not found" });
    const { name, credentials, enabled } = req.body || {};
    if (credentials !== undefined) {
      // Merge over the stored values so the UI can save a form whose secret
      // fields were left blank without wiping the credentials behind them.
      const merged = { ...existing.credentials };
      for (const [k, v] of Object.entries(credentials)) if (String(v ?? "").trim()) merged[k] = v;
      const invalid = bots.validateCredentials(existing.type, merged);
      if (invalid) return res.status(400).json({ error: invalid });
      req.body.credentials = merged;
    }
    const bot = db.updateBot(req.params.id, { name, credentials: req.body.credentials, enabled });
    bots.reload(bot);
    res.json(bots.maskBot(bot));
  });

  app.delete("/api/bots/:id", (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    if (!db.getBot(req.params.id)) return res.status(404).json({ error: "Bot not found" });
    bots.stop(req.params.id);
    db.deleteBot(req.params.id);
    res.json({ ok: true });
  });

  // ── Seen chats + relay channels (admin-gated) ──────────────────────────────
  //
  // The destination list a relay caller can address (add-bot-relay-endpoint).
  // A binding is creatable only from a chat the inbound pipeline recorded, so
  // the relay token can never be pointed at a chat this deployment has not
  // seen. These rows carry identity and timing only — no message text, and no
  // bot credentials.

  const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

  app.get("/api/bots/chats", (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    const names = new Map(db.listBots().map((b) => [b.id, b.name]));
    res.json({
      chats: db.listBotChats().map((c) => ({ ...c, botName: names.get(c.botId) ?? null })),
    });
  });

  app.get("/api/bots/channels", (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    res.json({ channels: db.listChannels() });
  });

  app.post("/api/bots/channels", (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    const { name, botId, chatKey } = req.body || {};
    if (!CHANNEL_NAME_RE.test(String(name ?? ""))) {
      return res.status(400).json({ error: "Channel name must match [a-z0-9][a-z0-9._-]{0,63}" });
    }
    if (!botId || !chatKey) return res.status(400).json({ error: "Missing botId or chatKey" });
    if (!db.getBot(botId)) return res.status(404).json({ error: "Bot not found" });
    if (!db.getBotChat(botId, chatKey)) {
      return res.status(400).json({ error: "That chat has never messaged this bot" });
    }
    try {
      db.createChannel({ name, botId, chatKey });
    } catch {
      // The primary key is the authority; a check-then-insert would race it.
      return res.status(409).json({ error: "Channel name already exists" });
    }
    res.json({ channel: db.getChannel(name) });
  });

  app.delete("/api/bots/channels/:name", (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    if (!db.deleteChannel(req.params.name)) {
      return res.status(404).json({ error: "Channel not found" });
    }
    res.json({ ok: true });
  });

  // ── Onboarding QR (user entry) ─────────────────────────────────────────────
  // Same posture as the read side of config management: behind the proxy /
  // forward-auth gate like every non-webhook route here, credentials stay
  // server-side, nothing about the request is logged. A disabled bot still
  // resolves — the QR advertises an entry the operator may be preparing.
  //
  // Failure isolation: every failure path answers 200 with
  // `{ strategy: "manual", url: null, qr: null, error? }` so the panel shows
  // the reason plus the manual-link fallback — a bad token, an unsupported
  // account type, or an upstream outage never 500s bot management.
  app.get("/api/bots/:id/qr", async (req, res) => {
    if (!requireDb(res)) return;
    const bot = db.getBot(req.params.id);
    if (!bot || !getAdapter(bot.type)?.qr) return res.status(404).json({ error: "Bot not found" });

    const { strategy, hintKey } = getAdapter(bot.type).qr;
    const hint = hintKey ?? "botsPage.qr.hint.manual";
    const manual = (error) => res.json({ strategy: "manual", url: null, qr: null, hint, ...(error && { error }) });

    // A stored entry link wins on every platform: it is the manual fallback's
    // save target, so an override must survive later panel opens.
    const manualUrl = String(bot.credentials?.qrUrl ?? "").trim();
    if (manualUrl) {
      try {
        return res.json({ strategy: "manual", url: manualUrl, qr: await qrSvg(manualUrl), hint });
      } catch (err) {
        return manual(err.message);
      }
    }

    if (strategy === "manual") {
      // No link yet: the panel prompts for it instead of failing.
      return manual();
    }

    try {
      const { url } = await getAdapter(bot.type).qr.resolve(bot.credentials);
      res.json({ strategy, url, qr: await qrSvg(url), hint });
    } catch (err) {
      manual(err.message);
    }
  });

  // ── Proactive outbound send ────────────────────────────────────────────────

  app.post("/api/bots/:id/send", async (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    const { chatKey, text } = req.body || {};
    if (!chatKey || !text) return res.status(400).json({ error: "Missing chatKey or text" });
    try {
      await bots.sendTo(req.params.id, chatKey, text);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}
