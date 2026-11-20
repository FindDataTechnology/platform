// line-credentials.js — per-line operation-MCP credentials
// (add-line-credential-refs, design D1).
//
// Four refs, two lifecycle types:
//   wire-customer / lex  — short-lived Logto ID tokens (aud = each line's own
//     Logto SPA app). Minted by a server-driven PKCE round trip on the user's
//     browser session (server/routes/line-credentials.js); the mint also
//     stores the line's ROTATING refresh token (offline_access), which is
//     renewed SERVER-SIDE (server/line-token-renewal.js,
//     add-line-credential-renewal) so unattended fleet turns never need a
//     browser. Expired tokens are still OMITTED from profiles — renewal's
//     job is to keep that from ever being observable.
//   wanxing-caller — a pasted long-lived sub2api `sk-` key (billing panel).
//     401 flips stale (re-paste to recover), mirroring the connector family.
//   wanxing-deployer — a pasted long-lived sub2api `sk-` key for cloud deployment.
//     Same paste semantics as wanxing-caller; used only when deploying to cloud.
//
// Tokens live only here and in the generated dsh profile. DB unavailable
// degrades to "unconnected".

import * as db from "./db.js";
import { ownerKey } from "./registry-credentials.js";

export const WIRE_CUSTOMER_CREDENTIAL_REF = "wire-customer";
export const LEX_CREDENTIAL_REF = "lex";
export const WANXING_CALLER_CREDENTIAL_REF = "wanxing-caller";
export const WANXING_DEPLOYER_CREDENTIAL_REF = "wanxing-deployer";

// Per-line public auth-config endpoints (client_id/scopes/issuer — no
// secrets). Shared by the mint route and the server-side renewal module; read
// live at use time so a line rotating its SPA client needs no platform
// redeploy. `ctx.lineMintTargets` overrides in tests.
export const MINT_TARGETS = {
  "wire-customer": { configUrl: "https://wire.finddatatech.cloud/api/console/auth/config" },
  lex: { configUrl: "https://lex.finddatatech.cloud/api/console/auth/config" },
};

// ID-token lines: re-mint is browser-driven; stale is not used (clear on 401).
const ID_TOKEN_LINES = new Set(["wire-customer", "lex"]);
const LINES = new Set([...ID_TOKEN_LINES, "wanxing-caller", "wanxing-deployer"]);

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

export function isWanxingDeployerRef(config) {
  return config?.credentialRef === WANXING_DEPLOYER_CREDENTIAL_REF;
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
// records the JWT exp when parseable. refreshToken (mint path only): a string
// stores the freshly issued rotator, null honestly clears renewal capability;
// undefined (a manual paste) keeps whatever chain the row already has.
export function store({ email, line, token, refreshToken }) {
  if (!LINES.has(line)) return null;
  if (typeof token !== "string" || !token.trim()) return null;
  const key = ownerKey(email);
  // First row for (email, line) is the delivery-observability event: a running
  // cell that cached "no credential" only recovers through the delivery
  // controller, so the row's creation must be visible in logs (no token
  // material) to adjudicate any recurrence.
  const firstRow = !db.getLineCredential(key, line);
  db.setLineCredential({
    email: key,
    line,
    token: token.trim(),
    tokenExp: tokenExpiry(token.trim()),
    stale: 0,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
  });
  if (firstRow) console.log(`[line-credentials] credential line created: ${key} ${line}`);
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
//   ID-token lines WITH a refresh token: flip stale (the row is a recovery
//     path — renewal or a fresh mint revives it; never clear the chain away).
//   ID-token lines without one (legacy/manual paste): drop the cache — the
//     browser re-mints on next visit.
//   wanxing-caller: flip stale (facet-market semantics; re-paste to recover).
// Returns true when state changed (= re-apply exactly once).
export function markInvalid(email, line) {
  const key = ownerKey(email);
  const row = db.getLineCredentialWithRefresh(key, line);
  if (!row) return false;
  if (ID_TOKEN_LINES.has(line)) {
    if (!row.token) return false;
    if (row.refreshToken) {
      if (row.stale) return false;
      db.markLineCredentialStale(key, line);
      return true;
    }
    db.clearLineCredential(key, line);
    return true;
  }
  if (row.stale) return false;
  db.markLineCredentialStale(key, line);
  return true;
}

// ── Server-side renewal (add-line-credential-renewal D2/D4) ─────────────────
// The refresh attempt itself lives in server/line-token-renewal.js (it needs
// the line's auth config and a fetch). Injected here at boot to keep the
// lib→server dependency direction clean; absent = degraded boot, no renewal.

let refreshAttempt = null;
export function setRefreshAttempt(fn) {
  refreshAttempt = typeof fn === "function" ? fn : null;
}

// Secret-bearing state for the renewal module: refresh token + expiry without
// the projection layer. Never exposed through status/liveToken.
export function renewalState(email, line) {
  return db.getLineCredentialWithRefresh(ownerKey(email), line);
}

export function markStale(email, line) {
  return db.markLineCredentialStale(ownerKey(email), line);
}

// The 401 safety net (design D4): before invalidating an ID-token row, try one
// server-side refresh. The current round is already lost either way; a live
// chain recovers the NEXT one. "no-refresh" → caller falls through to
// markInvalid's clear branch; "renewed" → row re-stored, caller re-applies;
// "failed" → caller flips the row stale via markInvalid.
export async function renewOn401(email, line) {
  const key = ownerKey(email);
  const row = db.getLineCredentialWithRefresh(key, line);
  if (!row?.refreshToken || !refreshAttempt) return "no-refresh";
  try {
    return (await refreshAttempt({ email: key, line })) ? "renewed" : "failed";
  } catch {
    return "failed";
  }
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
