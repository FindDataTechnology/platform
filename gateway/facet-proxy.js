// ── 壹座's embedded-facet proxy (add-facet-platform 2.5) ────────────────────
//
// When FACET_BASE_URL is configured the gateway stops hosting the pack
// market and instead proxies the whole /api/packs prefix onto the facet
// service — same-origin for the browser, so web/src/lib/packs-api.ts and the
// whole Settings → 功能集 surface work with zero frontend change. The user
// the gateway already verified rides along as a forwarded identity, stamped
// with the internal shared credential so the facet service accepts it
// (facet/identity.js). Without that credential facet treats the request as
// anonymous — correct for its public read face and harmless here, since the
// gateway only stamps identities it verified itself.
//
// Rollback = unset FACET_BASE_URL (the local-market mount below the proxy
// branch in gateway/index.js is the fallback) and restart.
//
// The header construction and the request shape are exported because the
// cell-side install fetch (server/pack-manifest-source.js,
// pack-install-server-side-manifest) addresses the same channel: the browser
// sends {packId, version} and the SERVER retrieves the manifest over exactly
// this credential + identity route — one definition, no second channel.

// Forwarded-identity + service-credential headers for one facet call. Identity
// travels only when verified; facet's proxy channel requires the token, so an
// anonymous caller lands as facet-anonymous (public read face answers, write
// routes 401 — same wall as before cutover).
export function facetForwardHeaders({ user, token, contentType, authorization, idempotencyKey, actingUser, actingGroups } = {}) {
  return {
    ...(user
      ? {
          "x-facet-user": Buffer.from(JSON.stringify({ email: user.email, groups: user.groups ?? [] })).toString("base64url"),
          "x-facet-token": token,
        }
      : {}),
    // Service credentials (the runner's / the facade's Bearer) ride verbatim —
    // the internal routes authenticate on the facet side.
    ...(authorization ? { Authorization: authorization } : {}),
    // The console's service-config channel (agent-service-config): the ACTOR
    // the wanxing facade verified rides through to the packs internal twin,
    // which enforces deployer-or-admin against it. Trust is transitive: a
    // caller can only use these alongside the internal service credential the
    // twin requires — without it they are inert.
    ...(actingUser ? { "x-acting-user": actingUser } : {}),
    ...(actingGroups ? { "x-acting-groups": actingGroups } : {}),
    ...(contentType ? { "Content-Type": contentType } : {}),
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

// One request shape for every facet call: the prefix proxy (verbatim method,
// body and caller headers) and the install fetch's version GET. Network
// failures and timeouts throw; HTTP status handling stays with the caller.
export function facetRequest({
  base,
  user,
  token,
  path,
  method = "GET",
  body,
  contentType,
  authorization,
  idempotencyKey,
  actingUser,
  actingGroups,
  fetchImpl = fetch,
  timeoutMs = 30_000,
}) {
  return fetchImpl(`${base}${path}`, {
    method,
    headers: facetForwardHeaders({ user, token, contentType, authorization, idempotencyKey, actingUser, actingGroups }),
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function registerFacetProxy(app, {
  base, // facet origin, no trailing slash
  resolveUser,
  token, // FACET_INTERNAL_TOKEN
  fetchImpl = fetch,
  timeoutMs = 30_000,
}) {
  const forward = async (req, res) => {
    const user = resolveUser(req);

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    let upstream;
    try {
      upstream = await facetRequest({
        base,
        token,
        user,
        path: req.originalUrl,
        method: req.method,
        body,
        contentType: req.headers["content-type"],
        authorization: req.headers.authorization,
        idempotencyKey: req.headers["idempotency-key"],
        // The console config channel's actor headers (agent-service-config) —
        // enumerated like the rest (this proxy rebuilds the header set rather
        // than passing caller headers verbatim; a live probe caught the strip
        // on 2026-10-07: the facet twin answered "x-acting-user required").
        actingUser: req.headers["x-acting-user"],
        actingGroups: req.headers["x-acting-groups"],
        fetchImpl,
        timeoutMs,
      });
    } catch (e) {
      return res.status(502).json({ error: `facet service unreachable: ${e?.message || e}` });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    const ctype = upstream.headers.get("content-type");
    if (ctype) res.type(ctype);
    res.send(buf);
  };

  // Every method, whole prefix — the facet service owns the marketplace API
  // surface entirely (including /api/packs/internal/*, which the runner and
  // the wanxing facade keep addressing through 壹座).
  app.all("/api/packs", forward);
  app.all("/api/packs/*", forward);
}
