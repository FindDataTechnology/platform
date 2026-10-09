// connector-credentials.js — per-user 萬星 connector PAT (connector-credentials).
//
// One row per identity: the `oct_…` PAT the connector's /me page mints, plus a
// 401-driven stale flag (the PAT has no expiry — revocation is user-driven, so
// staleness only ever comes from a failing call). The token lives only here and
// in the generated dsh profile, never in mcp.json (whose connector row carries
// `credentialRef: "connector"` instead) and never in a response to the browser
// (see `status`).
//
// Mirrors registry-credentials.js module-for-module: same owner-keying (hosted
// = identity email, auth off = machine owner), same write-only projection, same
// "a fresh store clears stale" recovery. Business-logic layer over db.js; DB
// unavailable degrades to "unconnected".

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

// Token-free projection for every API/UI consumer. No expiresAt by design:
// the PAT is opaque and has no expiry — "not live" is absence or 401-staleness.
export function status(email) {
  const row = db.getConnectorCredential(ownerKey(email));
  if (!row) return { ...UNCONNECTED };
  return {
    // "connected" means live: a stale row still exists (so the UI can say
    // re-paste instead of paste) but is not usable for injection.
    connected: !row.stale,
    stale: row.stale,
    updatedAt: row.updatedAt,
  };
}

// Store (or replace) the PAT. Shape is validated by the route (oct_ prefix +
// liveness probe); here any non-empty string is stored — this layer trusts its
// caller the same way the registry layer does.
export function store({ email, token }) {
  if (typeof token !== "string" || !token.trim()) return null;
  const row = db.setConnectorCredential({ email: ownerKey(email), token: token.trim() });
  return row ? status(email) : null;
}

export function disconnect(email) {
  return db.deleteConnectorCredential(ownerKey(email));
}

// 401 from a connector MCP tool: the PAT was revoked (or revoked-after-paste).
// Returns true when the state actually changed, so the caller re-applies the
// profile exactly once per invalidation — same contract as the registry path.
export function markInvalid(email) {
  if (!db.getConnectorCredential(ownerKey(email))) return false;
  return db.markConnectorCredentialStale(ownerKey(email));
}

// The token to inject into the effective profile, or null when there is none
// usable (absent or 401-stale). Null means "omit this server".
export function liveToken(email) {
  const row = db.getConnectorCredential(ownerKey(email));
  if (!row || row.stale) return null;
  return row.token;
}
