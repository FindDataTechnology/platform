// ── Logto identity source (add-broadcast-and-notification-inbox 1.2) ────────
//
// The ONLY authority on "who exists". Broadcast audience expansion asks this,
// never a local shadow table — a second roster would drift from the IdP and the
// drift would be invisible until someone did not get a message.
//
// Access is the Logto Management API (M2M): client_credentials against
// `${endpoint}/oidc/token` with the API resource indicator, then Bearer reads.
// The OIDC web app's credentials do NOT work here (measured: 400 invalid_client)
// — a dedicated M2M app that holds the "Logto Management API access" role is
// required, and its secret keeps the literal `#internal:` prefix.
//
// Identity unit is the EMAIL, not the Logto user id. Measured 2026-11-24: an
// org-member payload carries `primaryEmail`, and every consumer downstream
// (`/api/inbox`, `cells-registry.owner_email`, business-role assignments) is
// keyed by email. Answering ids would force an id→email bridge on every path
// for no gain, so this module answers emails and nothing else.
//
// Two facts about Logto's model that this file has to encode, both measured:
//   · an organization is addressed by `id` (`hnrbfpgq2717`), while `name`
//     (`lex-customers`) is a DISPLAY name. A caller naturally says the name, so
//     resolution goes name → id here rather than making every caller look it up.
//   · role membership in Logto is an ORG-SCOPED role assignment, not a global
//     one. Logto roles are therefore NOT used for business roles — those live in
//     the platform's own role document and are resolved locally (see the
//     composite source at the bottom of this file).
//
// Failure policy: throw. The audience resolver turns that into a refusal. A
// broadcast must never widen because a lookup failed.

const TOKEN_TTL_MS = 5 * 60_000; // refresh well before Logto's own expiry

export function createLogtoIdentitySource({
  endpoint,
  clientId,
  clientSecret,
  resource = "https://default.logto.app/api",
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const base = String(endpoint ?? "").replace(/\/+$/, "");
  const id = String(clientId ?? "").trim();
  const secret = String(clientSecret ?? "").trim();
  let cached = { token: null, at: 0 };
  // org name → id, filled on first use. Small and stable; a stale entry only
  // costs one failed lookup, and the cache is per-process (never persisted).
  const orgIdByName = new Map();

  function configured() {
    return Boolean(base && id && secret);
  }

  async function managementToken() {
    if (!configured()) throw new Error("logto identity source is not configured (endpoint/clientId/clientSecret)");
    if (cached.token && now() - cached.at < TOKEN_TTL_MS) return cached.token;
    const res = await fetchImpl(`${base}/oidc/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials", resource, scope: "all" }).toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`logto management token failed: ${res.status} ${detail.slice(0, 160)}`);
    }
    const body = await res.json();
    if (!body?.access_token) throw new Error("logto management token response carried no access_token");
    cached = { token: body.access_token, at: now() };
    return cached.token;
  }

  async function api(path) {
    const token = await managementToken();
    const res = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`logto GET ${path} failed: ${res.status} ${detail.slice(0, 160)}`);
    }
    return res.json();
  }

  /**
   * Walk a paginated Logto Management API list endpoint.
   *
   * Measured 2026-11-24: these endpoints answer with a BARE ARRAY, not an
   * envelope like `{users: [...]}`. Reading `body.users` silently yielded zero
   * rows for an org that provably had three members — the failure mode is a
   * broadcast that refuses with "zero hits" while the audience plainly exists.
   * `key` is kept only as a defensive fallback for any endpoint that does wrap.
   */
  async function apiAll(path, key) {
    const out = [];
    let page = 1;
    for (;;) {
      const sep = path.includes("?") ? "&" : "?";
      const body = await api(`${path}${sep}page=${page}&page_size=100`);
      const rows = Array.isArray(body)
        ? body
        : Array.isArray(body?.[key])
          ? body[key]
          : [];
      out.push(...rows);
      if (rows.length < 100) break;
      page += 1;
      if (page > 100) break; // hard stop: never loop forever on a misbehaving API
    }
    return out;
  }

  async function resolveOrgId(orgNameOrId) {
    const wanted = String(orgNameOrId ?? "").trim();
    if (!wanted) throw new Error("org id is required");
    // An id-shaped value passes straight through — saves a listing round-trip
    // for callers that already hold the id.
    if (/^[a-z0-9]{10,}$/i.test(wanted) && !wanted.includes("-")) return wanted;
    if (orgIdByName.has(wanted)) return orgIdByName.get(wanted);
    const orgs = await apiAll("/api/organizations", "organizations");
    for (const org of orgs) {
      if (org?.id) orgIdByName.set(String(org.name ?? ""), String(org.id));
    }
    const found = orgIdByName.get(wanted);
    if (!found) throw new Error(`no organization named "${wanted}"`);
    return found;
  }

  async function usersInOrg(orgNameOrId) {
    const orgId = await resolveOrgId(orgNameOrId);
    const members = await apiAll(`/api/organizations/${encodeURIComponent(orgId)}/users`, "users");
    return emails(members);
  }

  async function allUserEmails() {
    const users = await apiAll("/api/users", "users");
    return emails(users);
  }

  return { configured, usersInOrg, allUserEmails, resolveOrgId };
}

/** Emails, lowercased and deduped. A user without an email is not addressable. */
function emails(users) {
  return [
    ...new Set(
      (users ?? [])
        .map((u) => String(u?.primaryEmail ?? "").trim().toLowerCase())
        .filter((e) => e.includes("@")),
    ),
  ];
}

/**
 * A composite source that resolves business roles locally and org/all through
 * Logto.
 *
 * Why composite rather than extending the Logto client: the two authorities are
 * genuinely different. Logto owns users and organizations; the platform owns
 * BUSINESS roles (`legal`/`financial`/…) in its own role document. Asking Logto
 * for a business role is a category error — measured 2026-11-24: it returned
 * zero for every role because those roles do not exist there.
 *
 * Both sides answer EMAILS, so there is no bridging step and no id/email
 * translation anywhere in the audience path.
 */
export function createCompositeIdentitySource({ logto, emailsWithPrimaryRole, db }) {
  return {
    configured: () => logto.configured(),
    usersInOrg: (org) => logto.usersInOrg(org),
    allUserIds: () => logto.allUserEmails(),
    async usersWithRole(roleSlug) {
      // Synchronous local read, wrapped to the async source contract.
      return emailsWithPrimaryRole(roleSlug, db) ?? [];
    },
  };
}
