// Visitor identity for the outward entries (chatwoot-ai-handoff 5.x).
//
// `POST /api/bots/:id/visitor-identity` — given an opaque visitor id the browser
// already holds (or none, in which case one is minted), returns what the
// Chatwoot widget needs to bind to it: `{ identifier, identifier_hash }`.
//
// Why this endpoint exists rather than the browser doing it: the hash is
// HMAC-SHA256(widget_hmac_token, identifier), and that token is a server-side
// secret. A browser that could compute the hash itself could also forge any
// identifier — so the token never leaves the server.
//
// Why the hash at all: Chatwoot's widget accepts a bare identifier when the
// inbox is not hmac_mandatory, which would let anyone who learns an id read that
// visitor's history. The hash is what separates "know the id" from "be the
// visitor" (see lib/visitor-identity.js and the capability's 5.4 scenario).
//
// Which token: the bot's own credentials carry `widgetHmacToken` (the Chatwoot
// inbox's hmac_token). Falling back to the apiToken would be wrong — different
// secret, and Chatwoot would reject the hash.

import { mintVisitorId, isValidVisitorId, identityForWidget } from "../../lib/visitor-identity.js";

export function registerVisitorIdentityRoute(ctx) {
  const { app } = ctx;

  app.post("/api/bots/:id/visitor-identity", (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    const bot = ctx.db?.getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    if (bot.type !== "chatwoot") return res.status(400).json({ error: "visitor identity is only supported for chatwoot bots" });

    const token = String(bot.credentials?.widgetHmacToken ?? "").trim();
    if (!token) {
      // Refuse rather than hand out an unsigned identity: an id the widget
      // cannot verify is an id anyone can claim.
      return res.status(409).json({ error: "this chatwoot bot has no widgetHmacToken configured (identities would be forgeable)" });
    }

    const asked = req.body?.visitorId;
    let visitorId = null;
    if (asked != null && String(asked).trim() !== "") {
      // A caller-supplied id is only honoured if it is well-formed; anything
      // else is refused, never silently replaced (a silent replace would give
      // the visitor a NEW identity on every typo and split their history).
      const s = String(asked).trim();
      if (!isValidVisitorId(s)) return res.status(400).json({ error: "malformed visitorId" });
      visitorId = s;
    } else {
      visitorId = mintVisitorId();
    }

    try {
      const identity = identityForWidget(visitorId, token);
      res.json({ ...identity, visitorId });
    } catch (err) {
      // A programmer/config error, not a platform verdict.
      res.status(500).json({ error: err.message });
    }
  });
}