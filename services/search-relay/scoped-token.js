// ── Scoped relay tokens (add-mcp-credential-hygiene D1) ──────────────────────
//
// The ONE implementation shared by the relay (this directory) and the platform
// host (lib/scoped-relay-token.js re-exports this file; the platform image
// COPYs services/search-relay/scoped-token.js so the import resolves there).
// Zero dependencies beyond node builtins — the relay stays a zero-deploy
// single-directory service.
//
// Shape: wsrc-<scope-id>-<24 lowercase hex>
//   scope-id : caller-chosen stable attribution marker (hosted cells use
//              cell-<hash of owner email>); may itself contain dashes — the
//              MAC is always the LAST dash-delimited segment.
//   mac      : HMAC-SHA256(master, scope-id), first 24 hex chars.
//
// Stateless by design: the verifier needs only the master secret, no
// per-scope registry. No expiry claim — a stateless TTL cannot be shortened
// after a leak, a denylist entry can (revoked_scopes in keys.json, hot-
// reloaded by the relay).
//
// checkTokenAuth() is the relay's whole auth decision (static list first,
// then scoped); the relay handler and the tests call the same function.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SCOPED_PREFIX = "wsrc-";
const MAC_HEX_LEN = 24;
// No leading/trailing dash or dot; non-empty; printable URL-safe-ish set.
const SCOPE_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const MAC_RE = new RegExp(`^[0-9a-f]{${MAC_HEX_LEN}}$`);

function macFor(master, scopeId) {
  return createHmac("sha256", master).update(scopeId, "utf8").digest("hex").slice(0, MAC_HEX_LEN);
}

export function deriveScopedToken(master, scopeId) {
  if (typeof master !== "string" || master.length === 0) {
    throw new Error("scoped token: master secret is required");
  }
  if (!SCOPE_ID_RE.test(scopeId ?? "")) {
    throw new Error(`scoped token: bad scope id ${JSON.stringify(scopeId)}`);
  }
  return `${SCOPED_PREFIX}${scopeId}-${macFor(master, scopeId)}`;
}

// Structure-only parse (no crypto): { scopeId, macHex } | null.
export function parseScopedToken(token) {
  if (typeof token !== "string" || !token.startsWith(SCOPED_PREFIX)) return null;
  const body = token.slice(SCOPED_PREFIX.length);
  const lastDash = body.lastIndexOf("-");
  if (lastDash < 1) return null;
  const scopeId = body.slice(0, lastDash);
  const macHex = body.slice(lastDash + 1);
  if (!SCOPE_ID_RE.test(scopeId) || !MAC_RE.test(macHex)) return null;
  return { scopeId, macHex };
}

// Full verification. `revokedScopes` (array or Set) denies by scope id
// regardless of signature. MAC compare is constant-time.
export function verifyScopedToken(master, token, revokedScopes = []) {
  const parsed = parseScopedToken(token);
  if (!parsed) return { ok: false, reason: "malformed" };
  if (!master) return { ok: false, reason: "no-master", scopeId: parsed.scopeId };
  const revoked = revokedScopes instanceof Set ? revokedScopes : new Set(revokedScopes);
  if (revoked.has(parsed.scopeId)) return { ok: false, reason: "revoked", scopeId: parsed.scopeId };
  const expect = Buffer.from(macFor(master, parsed.scopeId), "utf8");
  const got = Buffer.from(parsed.macHex, "utf8");
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) {
    return { ok: false, reason: "bad-mac", scopeId: parsed.scopeId };
  }
  return { ok: true, scopeId: parsed.scopeId };
}

// The relay's complete auth decision. Returns { ok, tag, reason? } where tag
// is the log-safe attribution string (scope id for scoped tokens — it IS the
// attribution marker; 6-char prefix for static tokens — never a full value).
export function checkTokenAuth(token, { tokens = [], scopedMaster = "", revokedScopes = [] } = {}) {
  if (!token) return { ok: false, tag: "none", reason: "missing" };
  if (tokens.includes(token)) return { ok: true, tag: `${token.slice(0, 6)}…` };
  const v = verifyScopedToken(scopedMaster, token, revokedScopes);
  if (v.ok) return { ok: true, tag: `wsrc:${v.scopeId}` };
  return { ok: false, tag: "none", reason: v.reason };
}
