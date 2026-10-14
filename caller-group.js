// ── Registry caller-group assignment (add-agent-platform-ops D5, C-lite) ────
//
// After a user connects the MCP market (their personal registry credential is
// stored), the platform assigns their REGISTRY account the invoke-only caller
// group — the personal credential then passes the A2A invoke gate with
// per-user attribution (ADR-0013's C-lite settlement; the auth server's
// IDP_USER_GROUP_FALLBACK covers Logto users).
//
// Username resolution: the auth server keys the fallback lookup by the token
// subject (`sub`), so the row is written under that same claim — decoded from
// the freshly stored credential. Without a decodable token: the admin
// user-groups listing matched by email, then the paas-<slug> derivation.
//
// Upsert: the endpoint family only offers create (POST → 409 when the record
// exists) and field-replacement PATCH (→ 404 when it does not), so the record
// is read first and the caller group MERGED into the existing list. Failure
// only logs — the credential still serves market MCP either way.

import { ownerKey } from "./registry-credentials.js";

const CALLER_GROUP = process.env.REGISTRY_CALLER_GROUP || "paas-agent-callers";

function slugify(email) {
  return String(email || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "user";
}

// The registry username the fallback enrichment looks up: the minted
// credential's own subject claim (same provenance the auth server uses).
export function usernameFromToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const candidate = claims?.sub || claims?.username || claims?.preferred_username || claims?.email;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
  } catch {
    return null;
  }
}

// Ensure the connecting user's registry account carries the caller group.
// `doFetch`/`adminFetch(path, init)` receives registry-relative paths; the
// admin token is attached by the caller's wrapper (keeps this module
// credential-free).
export async function assignCallerGroup({ email, token = null, adminFetch, log = console }) {
  if (!email && !token) return { ok: false, reason: "no email" };
  let username = null;
  try {
    username = usernameFromToken(token);
    if (!username) {
      // No decodable token: resolve by email from the user-group listing
      // (rows surface the registry-side username), then derive locally.
      const listRes = await adminFetch("/api/iam/user-groups", { method: "GET" });
      const doc = await listRes.json().catch(() => null);
      const rows = doc?.items ?? doc?.groups ?? doc ?? [];
      const hit = Array.isArray(rows)
        ? rows.find((r) => r?.email === email || r?.username === `paas-${slugify(email)}`)
        : null;
      username = hit?.username ?? `paas-${slugify(email)}`;
    }

    const path = `/api/iam/user-groups/${encodeURIComponent(username)}`;
    const cur = await adminFetch(path, { method: "GET" });
    if (cur.ok) {
      const doc = await cur.json().catch(() => null);
      const groups = Array.isArray(doc?.groups) ? doc.groups : [];
      if (groups.includes(CALLER_GROUP)) return { ok: true, username, group: CALLER_GROUP, changed: false };
      // PATCH replaces the fields it carries: send the full merged list.
      const res = await adminFetch(path, { method: "PATCH", body: { groups: [...groups, CALLER_GROUP] } });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        log.warn(`[caller-group] assignment failed for ${username}: ${res.status} ${detail.slice(0, 120)}`);
        return { ok: false, reason: `HTTP ${res.status}` };
      }
      return { ok: true, username, group: CALLER_GROUP, changed: true };
    }
    if (cur.status !== 404) {
      log.warn(`[caller-group] lookup failed for ${username}: HTTP ${cur.status}`);
      return { ok: false, reason: `HTTP ${cur.status}` };
    }
    const res = await adminFetch("/api/iam/user-groups", {
      method: "POST",
      body: { username, groups: [CALLER_GROUP], ...(email ? { email } : {}) },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      log.warn(`[caller-group] assignment failed for ${email || username}: ${res.status} ${detail.slice(0, 120)}`);
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    return { ok: true, username, group: CALLER_GROUP, changed: true };
  } catch (e) {
    log.warn(`[caller-group] assignment error for ${email || username}: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// The default adminFetch over the market registry bridge.
export function marketAdminFetch({ registryUrl, token, fetchImpl = null } = {}) {
  const base = String(registryUrl || "").replace(/\/+$/, "");
  const doFetch = fetchImpl ?? ((p, init = {}) => fetch(base + p, init));
  return (p, init = {}) =>
    doFetch(base + p, {
      ...init,
      // fetch() coerces a plain-object body to "[object Object]" — the admin
      // API needs real JSON.
      ...(init?.body !== undefined && typeof init.body !== "string"
        ? { body: JSON.stringify(init.body) }
        : {}),
      headers: {
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
}

export { ownerKey, CALLER_GROUP };