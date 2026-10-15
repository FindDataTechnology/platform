// connector-credentials.js — per-user 萬星 connector PATs, one row per account
// (add-connector-account-picker).
//
// An identity holds one or more connector accounts keyed by a user-readable
// slot name (zero-paste names the slot after the connector login identity;
// paste defaults to 'default'). Exactly one account per identity is active —
// that account's token is what profile writes inject; switching is explicit,
// never automatic (a deleted or stale active account leaves nothing active
// until the user picks one). Zero-paste rows also carry the connector-side PAT
// id so disconnect/replace can best-effort revoke the old PAT.
//
// The token lives only here and in the generated dsh profile, never in
// mcp.json (whose connector row carries `credentialRef: "connector"` instead)
// and never in a response to the browser (see projections below).
//
// Mirrors registry-credentials.js module-for-module: same owner-keying (hosted
// = identity email, auth off = machine owner), same write-only projection,
// same "a fresh store clears stale" recovery. Business-logic layer over db.js;
// DB unavailable degrades to "unconnected".

import * as db from "./db.js";
import { ownerKey, MACHINE_OWNER_KEY } from "./registry-credentials.js";

export const CONNECTOR_CREDENTIAL_REF = "connector";

// Shared with registry-credentials (same identity model, same auth-off
// degradation); re-exported so consumers of this module never need both.
export { ownerKey, MACHINE_OWNER_KEY };

export function isConnectorRef(config) {
  return config?.credentialRef === CONNECTOR_CREDENTIAL_REF;
}

const UNCONNECTED = {
  connected: false,
  stale: false,
  updatedAt: null,
};

// Token-free projection of one account. No expiresAt by design: the PAT is
// opaque and has no expiry — "not live" is absence or 401-staleness. slot is
// echoed on every projection (route responses and tests key off it).
function projectRow(row) {
  if (!row) return { ...UNCONNECTED };
  return {
    slot: row.slot,
    // "connected" means live: a stale row still exists (so the UI can say
    // reconnect instead of connect) but is not usable for injection.
    connected: !row.stale,
    stale: row.stale,
    active: !!row.active,
    updatedAt: row.updatedAt,
  };
}

// Token-free projection for every API/UI consumer. shape: "single" (legacy
// status card: the active account as a flat object) or "list" (account rows).
export function status(email) {
  const row = db.getActiveConnectorCredential(ownerKey(email));
  return projectRow(row);
}

export function list(email) {
  const key = ownerKey(email);
  return db.listConnectorCredentials(key).map((row) => ({
    ...projectRow(row),
    // The route layer needs the PAT id for best-effort revocation; this module
    // is server-side only, so patId may appear here (the HTTP projection below
    // strips it before anything reaches the browser).
    patId: row.patId ?? null,
  }));
}

// The browser-facing projection: like list() but with the PAT id stripped —
// it's a server-side revocation handle, not UI data.
export function listForClient(email) {
  return list(email).map(({ patId, ...rest }) => rest);
}

// Store (or replace) one account's PAT. Shape is validated by the route (oct_
// prefix + liveness probe); here any non-empty string is stored — this layer
// trusts its caller the same way the registry layer does. patId comes from the
// zero-paste mint response and powers best-effort revocation.
export function store({ email, slot = "default", token, patId = null }) {
  if (typeof token !== "string" || !token.trim()) return null;
  const row = db.setConnectorCredential({ email: ownerKey(email), slot, token: token.trim(), patId });
  return row ? projectRow(row) : null;
}

export function setActive(email, slot) {
  return db.setConnectorCredentialActive(ownerKey(email), slot);
}

export function disconnect(email, slot = "default") {
  return db.deleteConnectorCredential(ownerKey(email), slot);
}

// 401 from a connector MCP tool: the active PAT was revoked (or
// revoked-after-paste). Returns true when the state actually changed, so the
// caller re-applies the profile exactly once per invalidation — same contract
// as the registry path. Only the active account can be the one injected, so
// only it flips.
export function markInvalid(email) {
  const key = ownerKey(email);
  if (!db.getActiveConnectorCredential(key)) return false;
  return db.markConnectorCredentialStale(key);
}

// The token to inject into the effective profile, or null when there is none
// usable (no active account, absent, or 401-stale). Null means "omit this
// server".
export function liveToken(email) {
  const row = db.getActiveConnectorCredential(ownerKey(email));
  if (!row || row.stale) return null;
  return row.token;
}
