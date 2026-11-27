// registry-credentials.js — per-user MCP-market credential (registry-sso-credentials).
//
// One row per identity: the token a registry-origin MCP server authenticates
// with, its expiry, and a stale flag. The token is minted through the
// registry's silent SSO popup (or pasted by hand) and lives only here and in
// the generated dsh profile — never in an installed record, never in a
// response to the browser (see `status`).
//
// Business-logic layer over db.js, mirroring extension-store.js: module
// functions, no class, DB-unavailable degrades to "unconnected".

import * as db from "./db.js";

// Installed records reference the credential by this constant instead of
// embedding a secret (design D2); the effective-profile writer resolves it.
export const REGISTRY_CREDENTIAL_REF = "registry";

// Identity for deployments with no authenticated identity (auth off: dev and
// desktop). A single-user machine has exactly one credential store, so the
// paste path and injection still work; hosted mode never reaches this key
// (its routes require an identity first).
export const MACHINE_OWNER_KEY = "machine-owner";

export function ownerKey(email) {
  return db.normalizeIdentityEmail(email) || MACHINE_OWNER_KEY;
}

export function isRegistryRef(config) {
  return config?.credentialRef === REGISTRY_CREDENTIAL_REF;
}

// Read a JWT's `exp` without verifying anything: the token is opaque to the
// platform (the registry validates it), we only surface its expiry. Non-JWT
// tokens (bring-your-own) return null = unknown expiry, which is not the same
// as expired — such a credential is dropped only by a 401.
export function tokenExpiry(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = payload?.exp;
    return typeof exp === "number" && Number.isFinite(exp)
      ? new Date(exp * 1000).toISOString()
      : null;
  } catch {
    return null;
  }
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= Date.now();
}

const UNCONNECTED = {
  connected: false,
  expiresAt: null,
  expired: false,
  stale: false,
  source: null,
  updatedAt: null,
};

// Token-free projection for every API/UI consumer.
export function status(email) {
  const row = db.getRegistryCredential(ownerKey(email));
  if (!row) return { ...UNCONNECTED };
  const expired = isExpired(row.expiresAt);
  return {
    // "connected" means live: a stale or expired row still exists (so the UI
    // can say re-connect instead of connect) but is not usable for injection.
    connected: !row.stale && !expired,
    expiresAt: row.expiresAt,
    expired,
    stale: row.stale,
    source: row.source,
    updatedAt: row.updatedAt,
  };
}

// Store (or replace) the credential. A decodable JWT's `exp` wins over a
// caller-supplied expiresAt; `source` is "sso" for the minted handoff, "paste"
// for the manual fallback (diagnostic only — the semantics are identical).
export function store({ email, token, expiresAt = null, source = "sso" }) {
  if (typeof token !== "string" || !token.trim()) return null;
  const value = token.trim();
  const row = db.setRegistryCredential({
    email: ownerKey(email),
    token: value,
    expiresAt: tokenExpiry(value) || (typeof expiresAt === "string" && expiresAt ? expiresAt : null),
    source: source === "paste" ? "paste" : "sso",
  });
  return row ? status(email) : null;
}

export function disconnect(email) {
  return db.deleteRegistryCredential(ownerKey(email));
}

// 401 from a registry MCP endpoint. Returns true when the state actually
// changed, so the caller re-applies the profile exactly once per expiry.
export function markStale(email) {
  if (!db.getRegistryCredential(ownerKey(email))) return false;
  return db.markRegistryCredentialStale(ownerKey(email));
}

// The token to inject into the effective profile, or null when there is none
// usable (absent, stale, or past its expiry). Null means "omit this server".
export function liveToken(email) {
  const row = db.getRegistryCredential(ownerKey(email));
  if (!row || row.stale || isExpired(row.expiresAt)) return null;
  return row.token;
}
