// server/pack-manifest-source.js
// Server-side pack-manifest retrieval for installs (openspec change
// pack-install-server-side-manifest).
//
// Why: pack manifests legally embed SKILL.md bodies carrying SQL / Python /
// markdown code fences. Shipping that body from the browser tripped the
// deployment edge WAF (SafeLine content rules; the 2026-10-06 壹座 market
// failure — connection reset for packs whose skills contain `WHERE name='…'`
// samples, 403 for `<script`/`UNION SELECT`). The install endpoint therefore
// takes {packId, version} and resolves the manifest HERE, over the same facet
// channel the /api/packs prefix proxy uses (gateway/facet-proxy.js): the same
// credential + forwarded-identity construction, so private-pack owner-scoped
// visibility and its 404-vs-200 answers match the market surface exactly.
//
// Two sources, in the deployment's own precedence order (mirrors
// gateway/index.js: facet when configured, else the market plane mounted in
// this process):
//   1. FACET_BASE_URL set — GET {facet}/api/packs/{id}/versions/{version}
//      under the caller's identity (x-facet-user/x-facet-token).
//   2. Otherwise the injected local market (single-process deployments and
//      the e2e suite, where server.js mounts the market plane in this very
//      process); the lookup goes through the registry's own visibility read.
// Retrieval failure is terminal: a clear error is thrown and the caller never
// reaches installPack, so nothing is written.

import { facetRequest } from "../gateway/facet-proxy.js";

const VERSION_NOT_FOUND = "Pack version not found";

const fail = (status, message) => Object.assign(new Error(message), { status });

export async function fetchMarketManifest({
  packId,
  version,
  viewer,
  localMarket = null,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 30_000,
}) {
  const base = (env.FACET_BASE_URL || "").replace(/\/+$/, "");
  if (base) {
    let upstream;
    try {
      upstream = await facetRequest({
        base,
        token: env.FACET_INTERNAL_TOKEN || "",
        user: viewer,
        path: `/api/packs/${encodeURIComponent(packId)}/versions/${encodeURIComponent(String(version))}`,
        fetchImpl,
        timeoutMs,
      });
    } catch (e) {
      throw fail(502, `pack marketplace unreachable: ${e?.message || e}`);
    }
    // The market answers not-found for invisible (private/foreign) and absent
    // versions alike — carry that answer through unchanged.
    if (upstream.status === 404) throw fail(404, VERSION_NOT_FOUND);
    if (!upstream.ok) throw fail(502, `pack marketplace fetch failed (HTTP ${upstream.status})`);
    const body = await upstream.json().catch(() => null);
    if (!body?.manifest) throw fail(502, "pack marketplace returned no manifest");
    return body.manifest;
  }

  if (localMarket?.getVersion) {
    const found = localMarket.getVersion(packId, version, viewer);
    if (!found?.manifest) throw fail(404, VERSION_NOT_FOUND);
    return found.manifest;
  }

  throw fail(503, "pack marketplace is not configured on this deployment");
}