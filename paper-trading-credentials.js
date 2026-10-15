// paper-trading-credentials.js — per-user 柏讯模拟交易 `fdt_` token
// (add-paper-trading-credentials).
//
// The service authenticates each MCP call by the caller's own long-lived
// `fdt_` token (no expiry, revocable server-side with immediate effect) and
// isolates accounts by it. There is no device-pairing protocol and no
// multi-account dimension: one pasted token per identity, full stop. A fresh
// paste replaces the row and clears stale — the only recovery path after a
// 401 flip (the token does not expire, so there is nothing to re-mint).
//
// Mirrors connector-credentials.js module-for-module, minus the parts this
// line does not have: no slot management (token IS the identity), no patId /
// best-effort revocation (a paste response carries no revocation handle; the
// user revokes on the service web). Same owner-keying (hosted = identity
// email, auth off = machine owner), same write-only projection. The token
// lives only here and in the generated dsh profile, never in any response to
// the browser. DB unavailable degrades to "unconnected".

import * as db from "./db.js";
import { ownerKey, MACHINE_OWNER_KEY } from "./registry-credentials.js";

export const PAPER_TRADING_CREDENTIAL_REF = "paper-trading";

// Shared with registry-credentials (same identity model, same auth-off
// degradation); re-exported so consumers of this module never need both.
export { ownerKey, MACHINE_OWNER_KEY };

export function isPaperTradingRef(config) {
  return config?.credentialRef === PAPER_TRADING_CREDENTIAL_REF;
}

const UNCONNECTED = {
  connected: false,
  stale: false,
  updatedAt: null,
};

// Token-free projection. No expiry by design: the token is long-lived and
// has no exp — "not live" is absence or 401-staleness (same discipline as
// the connector PAT projection).
function projectRow(row) {
  if (!row) return { ...UNCONNECTED };
  return {
    // "connected" means live: a stale row still exists (so the UI can say
    // revert/edit instead of connect) but is not usable for injection.
    connected: !row.stale,
    stale: row.stale,
    updatedAt: row.updatedAt,
  };
}

// Token-free projection for every API/UI consumer.
export function status(email) {
  const row = db.getPaperTradingCredential(ownerKey(email));
  return projectRow(row);
}

// Store (or replace) the token. Shape is validated by the route (fdt_ prefix
// + liveness probe); here any non-empty string is stored — this layer trusts
// its caller the same way the registry/connector layers do.
export function store({ email, token }) {
  if (typeof token !== "string" || !token.trim()) return null;
  const row = db.setPaperTradingCredential(ownerKey(email), token.trim());
  return row ? projectRow(row) : null;
}

export function disconnect(email) {
  return db.deletePaperTradingCredential(ownerKey(email));
}

// 401 from the paper-trading MCP tool: the stored token was revoked. Returns
// true when the state actually changed, so the caller re-applies the profile
// exactly once per invalidation — same contract as the other refs.
export function markInvalid(email) {
  return db.markPaperTradingCredentialStale(ownerKey(email));
}

// The token to inject into the effective profile, or null when there is none
// usable (no row, or 401-stale). Null means "omit this server".
export function liveToken(email) {
  const row = db.getPaperTradingCredential(ownerKey(email));
  if (!row || row.stale) return null;
  return row.token;
}
