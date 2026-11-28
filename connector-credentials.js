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
//
// The account is also the SOURCE of the built-in free-exploration binding
// (add-connector-bindings D5): sessions only ever inject binding rows, so the
// active account must have one, or connecting after the upgrade would store a
// token that nothing injects. `chat:explore` mirrors the ACTIVE account token;
// a non-active account stores no binding (switching to it later mirrors then).
export function store({ email, slot = "default", token, patId = null }) {
  if (typeof token !== "string" || !token.trim()) return null;
  const key = ownerKey(email);
  const row = db.setConnectorCredential({ email: key, slot, token: token.trim(), patId });
  if (!row) return null;
  mirrorExploreBinding(key);
  return projectRow(row);
}

// Mirror the active account's token into the built-in explore binding. Called
// after every change to the account set (store / setActive / disconnect) so the
// binding never carries a token the account no longer has, and never outlives
// it. A stale binding keeps its stale flag: a fresh paste clears it.
function mirrorExploreBinding(key) {
  const active = db.getActiveConnectorCredential(key);
  if (!active || active.stale) {
    if (active && active.stale) db.markConnectorBindingStale(key, db.CONNECTOR_EXPLORE_BINDING);
    else db.deleteConnectorBinding(key, db.CONNECTOR_EXPLORE_BINDING);
    return;
  }
  db.setConnectorBinding({
    email: key,
    slot: db.CONNECTOR_EXPLORE_BINDING,
    token: active.token,
    patId: active.patId ?? null,
    purpose: "内置自由探索",
    sourceAccount: active.slot,
  });
}

export function setActive(email, slot) {
  const key = ownerKey(email);
  const changed = db.setConnectorCredentialActive(key, slot);
  if (changed) mirrorExploreBinding(key);
  return changed;
}

export function disconnect(email, slot = "default") {
  const key = ownerKey(email);
  const removed = db.deleteConnectorCredential(key, slot);
  // The binding is a mirror: once the account is gone the binding must not keep
  // injecting its token.
  if (removed) mirrorExploreBinding(key);
  return removed;
}

// 401 from a connector MCP tool: the active PAT was revoked (or
// revoked-after-paste). Returns true when the state actually changed, so the
// caller re-applies the profile exactly once per invalidation — same contract
// as the registry path. Only the active account can be the one injected, so
// only it flips.
export function markInvalid(email) {
  const key = ownerKey(email);
  if (!db.getActiveConnectorCredential(key)) return false;
  const changed = db.markConnectorCredentialStale(key);
  if (changed) db.markConnectorBindingStale(key, db.CONNECTOR_EXPLORE_BINDING);
  return changed;
}

// The token to inject into the effective profile, or null when there is none
// usable (no active account, absent, or 401-stale). Null means "omit this
// server".
export function liveToken(email) {
  const row = db.getActiveConnectorCredential(ownerKey(email));
  if (!row || row.stale) return null;
  return row.token;
}
