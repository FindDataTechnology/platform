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
    // 身份头必须传对象：facetForwardHeaders 读的是 user.email，传裸邮箱字符串会解出
    // undefined 邮箱 → facet 判匿名 → private 包一律 404（报成误导性的 "Pack version
    // not found"）。试跑传的正是 blueprint.ownerEmail（字符串），2026-10-31 真机逮住：
    // 结构样例包因 private 而永远拉不到 manifest，看上去像「指针失效」。
    // 同坑在 createFacetPublishClient 里已于 2026-10-28 修过，读面这处漏了。
    const identity = typeof viewer === "string" ? { email: viewer, groups: [] } : viewer;
    let upstream;
    try {
      upstream = await facetRequest({
        base,
        token: env.FACET_INTERNAL_TOKEN || "",
        user: identity,
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

// 装前闸的证词源（add-market-revenue-share）：详情面读数 = 价格 + 该 viewer
// 的当前权益。两条来源与 manifest fetch 同缝（facet 远端 / in-process 本地
// 市场），不得让安装面绕过市场面自行推断「买过没有」。
// Returns { pricing?, purchased } or throws { status }.
export async function fetchMarketDetail({
  packId,
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
        path: `/api/packs/${encodeURIComponent(packId)}`,
        fetchImpl,
        timeoutMs,
      });
    } catch (e) {
      throw fail(502, `pack marketplace unreachable: ${e?.message || e}`);
    }
    if (upstream.status === 404) throw fail(404, VERSION_NOT_FOUND);
    if (!upstream.ok) throw fail(502, `pack marketplace fetch failed (HTTP ${upstream.status})`);
    const body = await upstream.json().catch(() => null);
    if (!body) throw fail(502, "pack marketplace returned no detail");
    return { pricing: body.pricing ?? null, purchased: body.purchased === true };
  }

  if (localMarket?.getLatest) {
    const found = localMarket.getLatest(packId, viewer);
    if (!found) throw fail(404, VERSION_NOT_FOUND);
    // 本地面的等价物：in-process 挂载的 market store 直接出权益投影,
    // pricing 字段若本地包装未给出则视为免费（与外端缺省同语义）。
    return {
      pricing: found.pricing ?? null,
      purchased:
        found.pricing && localMarket.market && viewer?.email
          ? Boolean(localMarket.market.activeEntitlement(viewer.email, packId))
          : found.pricing
            ? false
            : undefined,
    };
  }

  throw fail(503, "pack marketplace is not configured on this deployment");
}
// Latest-version lookup for SERVER-DRIVEN installs (intent-onboarding): the
// provisioning action knows the pack id from the recipe but has no version —
// the browser is not in the loop, so nothing supplies one. Resolves over the
// same facet channel (or the in-process market) the manifest fetch uses, under
// the same viewer identity, so visibility answers identically.
//
// Returns { version, manifest } or throws { status } — a pack the user cannot
// see answers 404, exactly like the market surface.
export async function fetchLatestPackVersion({
  packId,
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
        path: `/api/packs/${encodeURIComponent(packId)}`,
        fetchImpl,
        timeoutMs,
      });
    } catch (e) {
      throw fail(502, `pack marketplace unreachable: ${e?.message || e}`);
    }
    if (upstream.status === 404) throw fail(404, VERSION_NOT_FOUND);
    if (!upstream.ok) throw fail(502, `pack marketplace fetch failed (HTTP ${upstream.status})`);
    const body = await upstream.json().catch(() => null);
    if (!body?.version || !body?.manifest) throw fail(502, "pack marketplace returned no version");
    return { version: Number(body.version), manifest: body.manifest };
  }

  if (localMarket?.getLatest) {
    const found = localMarket.getLatest(packId, viewer);
    if (!found?.manifest) throw fail(404, VERSION_NOT_FOUND);
    return { version: Number(found.version), manifest: found.manifest };
  }

  throw fail(503, "pack marketplace is not configured on this deployment");
}

// Resolve curated pack REFERENCES to this deployment's ids (intent-onboarding).
// A recipe names its packs by their authored display name — the market mints
// ids randomly per deployment (`randomBytes(16)` in gateway/packs.js), so a
// static table cannot carry one (the v1 recipes shipped invented slugs like
// `legal-contract` and every provisioning run failed "Pack version not found").
//
// One search per reference over the same channel the install fetch uses, under
// the same viewer identity, keeping the market's EXACT-name rule: a pack the
// viewer cannot see never appears in the listing, so an invisible or absent
// reference resolves to nothing and the plan reports it unavailable.
//
// Returns { [ref]: { packId, name } } — resolved references only. Resolution
// failure is never terminal: the caller degrades the individual item.
export async function resolvePackReferences({
  refs,
  viewer,
  localMarket = null,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 15_000,
}) {
  const wanted = [...new Set((refs ?? []).filter((r) => typeof r === "string" && r.trim()))];
  const out = {};
  if (!wanted.length) return out;

  const base = (env.FACET_BASE_URL || "").replace(/\/+$/, "");
  const pick = (ref, entries) => {
    const hit = entries.find((p) => p?.name === ref);
    if (hit?.id) out[ref] = { packId: hit.id, name: hit.name };
  };

  for (const ref of wanted) {
    if (base) {
      let upstream;
      try {
        upstream = await facetRequest({
          base,
          token: env.FACET_INTERNAL_TOKEN || "",
          user: viewer,
          path: `/api/packs?search=${encodeURIComponent(ref)}&pageSize=50`,
          fetchImpl,
          timeoutMs,
        });
      } catch (e) {
        console.warn(`[onboarding] pack reference '${ref}' unresolved (marketplace unreachable: ${e?.message || e})`);
        continue;
      }
      if (!upstream.ok) continue;
      const body = await upstream.json().catch(() => null);
      pick(ref, body?.packs ?? []);
      continue;
    }
    if (localMarket?.findByName) {
      pick(ref, localMarket.findByName(ref, viewer));
    }
  }
  return out;
}
