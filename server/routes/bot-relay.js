// Bot relay route (add-bot-relay-endpoint) — machine callers on an
// operator-trusted network delivering text through a pre-bound channel.
//
// This prefix is exempt from the identity gate in server/auth.js for the same
// reason the bot webhooks are: a machine cannot present a browser session. It
// carries its own authentication instead — a deployment-injected bearer token
// compared in constant time (the same helper the hosted-mode gateway secret
// uses).
//
// Trust rules, in order:
//   1. No token configured → 404. The route does not exist in a weaker form.
//   2. Token missing/incorrect → 401 before the body is read. server.js skips
//      its global JSON parser for this prefix for exactly that reason; the
//      parser below runs only after the token checks out.
//   3. Past auth: the caller names a channel and the destination is the
//      administrator's binding — never the caller's input. Guards, delivery,
//      and audit live in bots.relaySend().
//
// Nothing here logs the token, and the payload is never logged at all.

import express from "express";
import * as bots from "../bots.js";
import { secretMatches } from "../auth.js";

// Shared with the forward-auth exemption in auth.js. This prefix hosts exactly
// one route: everything under it is reachable without an identity, so nothing
// else may be mounted here.
export const RELAY_PREFIX = "/api/bots/relay/";

const relayToken = () => String(process.env.BOTS_RELAY_TOKEN || "").trim();

const bearer = (header) => {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || "").trim());
  return m ? m[1].trim() : null;
};

const STATUS_BY_REASON = {
  "unknown-channel": 404,
  "too-long": 400,
  "rate-limited": 429,
  "bot-unavailable": 409,
  "send-failed": 502,
  unavailable: 503,
};

function relayErrorMessage(result) {
  switch (result.reason) {
    case "unknown-channel":
      return "Unknown channel";
    case "too-long":
      return `Text must be 1-${bots.MAX_RELAY_CHARS} characters`;
    case "rate-limited":
      return "Channel send rate exceeded";
    case "bot-unavailable":
      return "The channel's bot is not available";
    case "unavailable":
      return "Bot relay unavailable (database not open)";
    default:
      // The platform's own failure, with credential values redacted upstream.
      return result.error || "Send failed";
  }
}

export function registerBotRelayRoutes(ctx) {
  const { app } = ctx;

  // Authentication is its own middleware, mounted BEFORE the body parser: a
  // request with a missing or wrong token must not have its payload parsed at
  // all — otherwise a malformed body would answer 400 from the parser and a
  // valid-looking one would be in memory before the token was ever checked.
  const relayAuth = (req, res, next) => {
    const expected = relayToken();
    if (!expected) return res.sendStatus(404);
    if (!secretMatches(bearer(req.headers.authorization), expected)) {
      return res
        .status(401)
        .set("WWW-Authenticate", "Bearer")
        .json({ error: "Invalid relay token" });
    }
    next();
  };

  app.post(`${RELAY_PREFIX}send`, relayAuth, express.json({ limit: "64kb" }), async (req, res) => {
    const { channel, text } = req.body || {};
    if (!channel) return res.status(400).json({ error: "Missing channel" });

    const result = await bots.relaySend(String(channel), text);
    if (result.ok) return res.json({ ok: true });
    if (result.reason === "rate-limited") res.set("Retry-After", "60");
    res.status(STATUS_BY_REASON[result.reason] ?? 500).json({ error: relayErrorMessage(result) });
  });

  // A body-parser failure on this prefix answers 400 (or 413 when over the
  // size cap) instead of the default 500: the caller is a machine and gets a
  // decision it can act on. Everything else falls through.
  app.use(RELAY_PREFIX, (err, req, res, next) => {
    if (!err) return next();
    res.status(err.status === 413 ? 413 : 400).json({ error: "Malformed request body" });
  });
}
