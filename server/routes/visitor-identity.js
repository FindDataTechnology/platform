// Visitor identity for the outward entries (chatwoot-ai-handoff 5.x).
//
// `POST /api/widget/visitor-identity` — the official site's browser holds an
// opaque visitor id and needs what Chatwoot's widget requires to bind to it:
// `{ identifier, identifier_hash }`.
//
// Two properties shape this endpoint, and they pull in opposite directions:
//
//   1. It must be reachable WITHOUT a login. The visitor is anonymous; a 401
//      here means no shared identity at all. So it is on the auth exemption
//      list, and that is safe ONLY because of property 2.
//
//   2. It must not be an oracle that signs arbitrary ids. If a caller could
//      name any identifier and get a valid hash, the hash would be worthless —
//      anyone could forge any visitor. So the id is MINTED SERVER-SIDE, never
//      taken from the request. A caller may present an id it already holds, and
//      the server SIGNS IT ONLY IF IT IS ONE IT MINTED EARLIER (proven by the
//      caller echoing the matching signature — it cannot, without having
//      received it from us). In practice: the caller passes back the id and the
//      hash it was given; we re-derive the hash from our own token and compare.
//
// Which visitor token: the widget's own `website_token` (public by design, it
// ships in every page's HTML) selects the bot. That is a routing key, not a
// credential — the SECRET is the inbox's hmac_token, which never leaves here.
//
// TTL: an identifier signed today is valid forever on Chatwoot's side (it is
// just an HMAC), so "re-signing the same id" is not an escalation — the caller
// already holds a working signature. That is why the echo check is enough.

import { mintVisitorId, isValidVisitorId, identityForWidget } from "../../lib/visitor-identity.js";

export function registerVisitorIdentityRoute(ctx) {
  const { app } = ctx;

  app.post("/api/widget/visitor-identity", (req, res) => {
    const websiteToken = String(req.body?.websiteToken ?? "").trim();
    if (!websiteToken) return res.status(400).json({ error: "websiteToken is required" });

    // The website token routes to a bot; it is not a secret (it is in the page
    // HTML). Find the bot whose credentials carry it.
    const bot = (ctx.db?.listBots?.() ?? []).find(
      (b) => b.type === "chatwoot" && String(b.credentials?.websiteToken ?? "").trim() === websiteToken,
    );
    if (!bot) return res.status(404).json({ error: "no bot serves this website token" });

    const hmacToken = String(bot.credentials?.widgetHmacToken ?? "").trim();
    if (!hmacToken) {
      // Refuse rather than hand out an unsigned identity: an id the widget
      // cannot verify is an id anyone can claim.
      return res.status(409).json({ error: "this bot has no widgetHmacToken configured (identities would be forgeable)" });
    }

    const askedId = String(req.body?.visitorId ?? "").trim();
    const askedHash = String(req.body?.identifierHash ?? "").trim();

    let visitorId;
    if (askedId) {
      if (!isValidVisitorId(askedId)) return res.status(400).json({ error: "malformed visitorId" });
      // Signing an arbitrary id would defeat the hash. Only re-sign one we can
      // prove we minted: the caller must present the hash we gave it, and it
      // must be the hash OUR token produces for this id.
      const expected = identityForWidget(askedId, hmacToken).identifier_hash;
      if (!askedHash || askedHash !== expected) {
        // Same shape whether the id is unknown or the hash is wrong — never tell
        // a prober which ids exist.
        return res.status(403).json({ error: "unknown visitor id" });
      }
      visitorId = askedId;
    } else {
      // First contact: mint. This is the only path that creates a new identity.
      visitorId = mintVisitorId();
    }

    const identity = identityForWidget(visitorId, hmacToken);
    res.json({ ...identity, visitorId, minted: !askedId });
  });
}