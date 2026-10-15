// line-credentials.js — per-line operation-MCP credentials
// (add-line-credential-refs, design D1).
//
// Three refs, two lifecycle types:
//   wire-customer / lex  — short-lived Logto ID tokens (aud = each line's own
//     Logto SPA app; the browser mints them by PKCE + prompt=none against the
//     shared Logto session and POSTs them here — the server NEVER mints, the
//     upstream lines verify signature+audience themselves). Expired tokens are
//     OMITTED from profiles; the browser re-mints on next platform visit.
//   wanxing-caller — a pasted long-lived sub2api `sk-` key (billing panel).
//     401 flips stale (re-paste to recover), mirroring the connector family.
//
// Tokens live only here and in the generated dsh profile. DB unavailable
// degrades to "unconnected".

import * as db from "./db.js";
import { ownerKey } from "./registry-credentials.js";

export const WIRE_CUSTOMER_CREDENTIAL_REF = "wire-customer";
export const LEX_CREDENTIAL_REF = "lex";
export const WANXING_CALLER_CREDENTIAL_REF = "wanxing-caller";

// ID-token lines: re-mint is browser-driven; stale is not used (clear on 401).
const ID_TOKEN_LINES = new Set(["wire-customer", "lex"]);
const LINES = new Set([...ID_TOKEN_LINES, "wanxing-caller"]);

const UNCONNECTED = {
  connected: false,
  stale: false,
  expiresAt: null,
};

export function isLineRef(line) {
  return (config) => config?.credentialRef === line;
}

export function isWireCustomerRef(config) {
  return config?.credentialRef === WIRE_CUSTOMER_CREDENTIAL_REF;
}

export function isLexRef(config) {
  return config?.credentialRef === LEX_CREDENTIAL_REF;
}

export function isWanxingCallerRef(config) {
  return config?.credentialRef === WANXING_CALLER_CREDENTIAL_REF;
}

function projectRow(row) {
  if (!row) return { ...UNCONNECTED };
  const exp = row.tokenExp ?? null;
  return {
    connected: !row.stale && Boolean(row.token) && (exp === null || exp > Date.now()),
    stale: !!row.stale,
    expiresAt: exp,
  };
}

export function status(email, line) {
  return projectRow(db.getLineCredential(ownerKey(email), line));
}

// Store a minted ID token (wire/lex) or pasted sk- (wanxing-caller). Shape
// validation lives in the route; this layer accepts non-empty strings and
// records the JWT exp when parseable.
export function store({ email, line, token }) {
  if (!LINES.has(line)) return null;
  if (typeof token !== "string" || !token.trim()) return null;
  const key = ownerKey(email);
  db.setLineCredential({
    email: key,
    line,
    token: token.trim(),
    tokenExp: tokenExpiry(token.trim()),
    stale: 0,
  });
  return status(key, line);
}

export function disconnect(email, line) {
  if (!LINES.has(line)) return false;
  return db.clearLineCredential(ownerKey(email), line);
}

// Read a JWT's exp without verifying (the line verifies; we only surface it).
function tokenExpiry(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// 401 from a line MCP tool.
//   ID-token lines: drop the cache — the browser re-mints on next visit.
//   wanxing-caller: flip stale (facet-market semantics; re-paste to recover).
// Returns true when state changed (= re-apply exactly once).
export function markInvalid(email, line) {
  const key = ownerKey(email);
  const row = db.getLineCredential(key, line);
  if (!row) return false;
  if (ID_TOKEN_LINES.has(line)) {
    if (!row.token) return false;
    db.clearLineCredential(key, line);
    return true;
  }
  if (row.stale) return false;
  db.markLineCredentialStale(key, line);
  return true;
}

// The token to inject into the effective profile, or null when there is none
// usable. ID-token lines: expired ⇒ null (server omitted; browser re-mints).
// wanxing-caller: stale ⇒ null until re-paste.
export function liveToken(email, line) {
  const row = db.getLineCredential(ownerKey(email), line);
  if (!row || row.stale) return null;
  const exp = row.tokenExp ?? null;
  if (exp !== null && exp <= Date.now()) return null;
  return row.token;
}
