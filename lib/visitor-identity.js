// Shared anonymous visitor identity across outward entries (chatwoot-ai-handoff 5.x).
//
// The goal: the same visitor on the Copilot panel and on the Chatwoot widget is
// ONE contact, so a handoff can show the human what the AI already discussed.
//
// Chatwoot already mints a stable per-browser id for every widget visitor
// (`contact_inboxes.source_id`), but that id lives inside the widget's own
// storage and the Copilot panel cannot read it. So this module makes the
// reverse arrangement: the FIRST entry to see the visitor mints an opaque id,
// the browser keeps it, and BOTH entries present it.
//
// The security constraint that shapes everything here: Chatwoot's widget
// accepts an `identifier` WITHOUT any proof when the inbox's hmac_mandatory is
// false (contacts_controller#should_verify_hmac?). That means a caller could
// claim someone else's identifier and be shown their conversation. So we require
// the hash: the server computes `HMAC-SHA256(widget_hmac_token, identifier)` and
// the widget verifies it. An identifier is only as good as its hash — handing
// out a bare id would turn "know the id" into "read the history".
//
// This module is pure: no I/O, so it is testable and has one obvious caller
// (the route that serves the Copilot panel's identity token).

import crypto from "node:crypto";

// 32 hex chars = 128 bits from the OS CSPRNG. Opaque, no PII, no structure a
// visitor could guess or a log entry could leak meaningfully.
export function mintVisitorId() {
  return crypto.randomBytes(16).toString("hex");
}

// The identifier is a fixed-shape token, so a malformed one is refused rather
// than sent to Chatwoot (which would mint a junk contact on every typo).
const VISITOR_ID_RE = /^[0-9a-f]{32}$/;

export function isValidVisitorId(id) {
  return typeof id === "string" && VISITOR_ID_RE.test(id);
}

/**
 * The identity payload a widget needs to bind to `visitorId`.
 *
 * @param {string} visitorId          32-hex id minted by mintVisitorId()
 * @param {string} widgetHmacToken    the inbox's hmac_token (Chatwoot: channel_web_widgets.hmac_token)
 * @returns {{identifier: string, identifier_hash: string}}
 * @throws when the id is malformed or no token is configured — an unsigned
 *         identity must never be produced silently (that is the exploit).
 */
export function identityForWidget(visitorId, widgetHmacToken) {
  if (!isValidVisitorId(visitorId)) throw new Error("identityForWidget: malformed visitor id");
  const token = String(widgetHmacToken ?? "").trim();
  if (!token) throw new Error("identityForWidget: no widget hmac token configured (an unsigned identity is forgeable)");
  const identifier_hash = crypto.createHmac("sha256", token).update(visitorId).digest("hex");
  return { identifier: visitorId, identifier_hash };
}

// Prefix for the note the handoff writes; kept here so the writer and any reader
// agree on one constant rather than two string literals drifting apart.
export const HANDOFF_ATTR_KEY = "paas_handoff";