// ── Facet — the standalone share-plane service (add-facet-platform S1) ───────
//
// The pack marketplace and its registry, extracted from the 壹座 process into
// an independently deployable service (ADR-0015 homes the registry under
// facet too). Same modules, verbatim (the mp-auth reuse pattern, third
// outing): gateway/packs.js provides the registry + routes, server/logto-auth
// the OIDC session. Two identity arrival channels, one user key:
//   1. direct — OIDC authorization code against the shared Logto tenant,
//      facet's own session cookie scoped to the facet domain;
//   2. embedded — 壹座's same-origin proxy forwards the identity it already
//      verified, over an internal shared credential (x-facet-token). Without
//      that token a forwarded-identity header is ignored and the request is
//      anonymous — the public domain must not let anyone mint identities.
// With 壹座 entirely down, everything here keeps working: browsing, detail,
// skill downloads of public packs (anonymous read face), direct login,
// publishing, deploying.
//
// Third identity channel (add-facet-publish-bridge, F3.2): a paired device's
// app token — the CLI publish bridge's door. Same pairing modules as the
// gateway (pairing.js), inert without MP_TOKEN_SECRET.

import path from "node:path";
import express from "express";
import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";
import { createSupplyStore, registerSupplyStoreRoutes } from "../gateway/supply-store.js";
import { registerVendorRoutes } from "../gateway/vendors.js";
import { registerOnboardingRoutes } from "../gateway/vendor-onboarding.js";
import { registerMarketRoutes } from "../gateway/market.js";
import { createLogtoAuth } from "../server/logto-auth.js";
import { resolveSessionSecret } from "../server/session.js";
import { createResolveUser } from "./identity.js";
import { initFacetMcpCatalog } from "./mcp-catalog.js";
import { getRepoAnnotation, getRepoSkillAnnotation, loadRepoAnnotations } from "../lib/market-annotations.js";
import { bundledJson } from "../paths.js";
import { initSupplyCatalog } from "./supply-catalog.js";
import { registerMcpRegistryJson } from "./mcp-registry-json.js";
import { registerMarketplaceJson } from "./marketplace-json.js";
import { createFacetPairing, registerPairingRoutes, withAppBearer } from "./pairing.js";
import { registerSameNamePublishGate } from "./publish-gate.js";
import { registerStudioRoutes } from "./studio.js";
import { machineSurfaceGuard } from "./machine-paths.js";

const PORT = Number(process.env.PORT || 8080);
const DATA_ROOT = process.env.FACET_DATA_ROOT || process.env.DATA_ROOT || path.resolve("data");
const WEB_DIST = process.env.FACET_WEB_DIST || path.resolve("web", "dist");
const PUBLIC_BASE = (process.env.PAAS_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");

const splitGroups = (v, fallback) =>
  (v || fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const logtoAuth = await createLogtoAuth({
  AUTH_MODE: process.env.AUTH_MODE || "logto",
  LOGTO_ENDPOINT: process.env.LOGTO_ENDPOINT || "",
  LOGTO_APP_ID: process.env.LOGTO_APP_ID || "",
  LOGTO_APP_SECRET: process.env.LOGTO_APP_SECRET || "",
  LOGTO_CLIENT_TYPE: process.env.LOGTO_CLIENT_TYPE || "confidential",
  LOGTO_END_SESSION: process.env.LOGTO_END_SESSION || "true",
  SESSION_TTL_HRS: process.env.SESSION_TTL_HRS || "24",
  PAAS_BASE_URL: PUBLIC_BASE,
  resolveSessionSecret: () => resolveSessionSecret({ env: process.env }),
}).catch((e) => {
  // Direct login is a production requirement, but a config-less local run
  // (anonymous face only) must still boot — say why and continue.
  console.warn(`[facet] direct login disabled (${e.message})`);
  return null;
});

const pairing = createFacetPairing({
  dataRoot: DATA_ROOT,
  tokenSecret: process.env.MP_TOKEN_SECRET || "",
  ttlHours: Number(process.env.MP_TOKEN_TTL_HOURS || 12),
});

const resolveUser = withAppBearer(
  createResolveUser({
    expectedToken: process.env.FACET_INTERNAL_TOKEN || "",
    // Read-only session resolution: the facet never owns the browser cookie,
    // so there is no res to slide it on — authenticate(req) would reach
    // slideCookie with an undefined res and CRASH every authenticated
    // request whose cookie sits inside the renewal half-window (live
    // 2026-10-22: pack publish/validate 502'd on a 1h-signed cookie).
    sessionAuth: logtoAuth ? (req) => logtoAuth.userFromCookie(req.headers.cookie) : null,
  }),
  pairing.appAuth,
);

function rejectUnauthenticated(_req, res) {
  return res.status(401).json({ error: "Authentication required", loginUrl: "/auth/login" });
}

const registry = createPackRegistry({ file: path.join(DATA_ROOT, "packs.db") });
const creatorGroups = splitGroups(process.env.PACK_CREATOR_GROUPS, "creators");
const adminGroups = splitGroups(process.env.ADMIN_GROUPS, "");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
// add-packaged-skills D2: publishes may carry inline skill packages (~21MiB
// manifests). This GLOBAL parser must allow it or the publish route's own
// jsonLimit is shadowed — Express runs this one first.
app.use(express.json({ limit: "24mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "facet" }));

// Identity probe for the SPA header. `creator`/`admin` are computed HERE —
// the group-name envs (PACK_CREATOR_GROUPS / ADMIN_GROUPS) are server
// config the client must not duplicate (add-facet-content-management).
// `accessMode` (add-opening-gates) exposes the effective publish/deploy
// posture (closed = creator group required; open = any authenticated user).
const accessMode = String(process.env.PACK_ACCESS_MODE || "").toLowerCase() === "open" ? "open" : "closed";
app.get("/api/whoami", (req, res) => {
  const user = resolveUser(req);
  if (!user) return res.json({ email: null, groups: [], creator: false, admin: false, accessMode, vendors: [] });
  const groups = user.groups ?? [];
  res.json({
    email: user.email,
    groups,
    creator: creatorGroups.some((g) => groups.includes(g)),
    admin: adminGroups.some((g) => groups.includes(g)),
    accessMode,
    // Vendor supply-open: active bindings for the SPA's publish attribution
    // picker and the onboarding console. Capability stays server判定 — this
    // is a display projection only (design D1).
    vendors: (registry.vendors?.bindingsFor(user.email) ?? []).map((b) => ({ slug: b.slug, displayName: b.displayName, role: b.role })),
  });
});

// Cell-side install surface: subscribing records at the market (works here),
// but materializing into a cell is a 壹座 surface by design (browser-mediated
// install, D8). The SPA dialog surfaces this message verbatim.
app.all("/api/mypacks", rejectUnauthenticatedSoft);
app.all("/api/mypacks/*", rejectUnauthenticatedSoft);
function rejectUnauthenticatedSoft(_req, res) {
  res.status(501).json({
    error: "订阅已记录。安装到运行时请在壹座内完成：打开壹座 → 设置 → 功能集 → 我的功能集。",
    code: "INSTALL_IS_A_BASE_SURFACE",
  });
}

if (logtoAuth) logtoAuth.register(app);

// Pairing doors (bindcode + pair/challenge/login + device management) before
// the pack routes — the CLI publish bridge's login rides them.
registerPairingRoutes(app, {
  appAuth: pairing.appAuth,
  mpBindings: pairing.bindings,
  resolveUser,
  rejectUnauthenticated,
});

// Same-name publish gate (add-mixed-fleet-packs-and-market-consolidation D5):
// a pre-route ahead of the publish handler — registration order is what makes
// it run first. One author, one name: a same-name republish is a structured
// 409 naming the existing pack and the upgrade path; nothing is stored.
registerSameNamePublishGate(app, { registry, resolveUser });

// Supply-domain Studio (add-supply-studio-migration W2 1.x): the creation
// surface moves here from the 壹座 face — document store (studio-docs.db,
// blueprint schema byte-compatible for the migration), lifecycle/validation/
// cast routes reused verbatim, in-process publish through the pack registry's
// gate sequence, deferred trial channel (run-domain pending, task 5.3).
// Mounted always; the web face routes in facet/web (task 1.6, single release
// with the 壹座-side teardown).
registerStudioRoutes(app, { resolveUser, registry, dataRoot: DATA_ROOT });

registerPackRoutes(app, {
  registry,
  resolveUser,
  rejectUnauthenticated,
  creatorGroups,
  adminGroups,
  anonymousRead: true,
  vendors: registry.vendors,
  market: registry.market,
  // Official showcase (add-official-pack-showcase): the facet market is
  // anonymous-first, so the badge rides its rows too — same roster env as the
  // gateway mount, one deployment one truth.
  officialAuthors: (process.env.OFFICIAL_AUTHOR_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
});

// Vendor supply-open (add-vendor-supply-open): identity + 供方上牌闸 — both
// marketplace-plane, mounted BEFORE the SPA fallback so /api/vendors is real.
registerVendorRoutes(app, { vendors: registry.vendors, resolveUser, rejectUnauthenticated, adminGroups });
registerOnboardingRoutes(app, {
  vendors: registry.vendors,
  onboarding: registry.onboarding,
  resolveUser,
  rejectUnauthenticated,
  adminGroups,
});

// Market revenue share (add-market-revenue-share): 成交/结算/收益读面 —
// 同 packs.db 生命周期单元, sub2api 客户端内置默认（SUB2API_* env）。
registerMarketRoutes(app, {
  registry,
  vendors: registry.vendors,
  market: registry.market,
  resolveUser,
  rejectUnauthenticated,
  adminGroups,
});

// Pack usage aggregate (add-facet-content-management): read-only proxy to the
// platform gateway's ops aggregate over an in-cluster service credential —
// the curation board reads supply-side numbers (weekly actives, turns) next
// to the packs they belong to. Admin-session-gated here, bearer-gated there.
// An unconfigured or unreachable source degrades honestly (503); curation
// itself never depends on it, and this surface never writes.
app.get("/api/ops/pack-usage", async (req, res) => {
  const user = resolveUser(req);
  if (!user || !adminGroups.some((g) => (user.groups ?? []).includes(g))) {
    return res.status(401).json({ error: "admin session required" });
  }
  const base = (process.env.PLATFORM_INTERNAL_URL || "").replace(/\/+$/, "");
  const token = process.env.PACK_USAGE_TOKEN?.trim() || "";
  if (!base || !token) return res.status(503).json({ error: "usage source not configured" });
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 365);
  try {
    const r = await fetch(`${base}/api/ops/pack-usage?days=${days}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    res.status(r.status).type("json").send(await r.text());
  } catch (err) {
    res.status(503).json({ error: `usage source unreachable (${err?.message || err})` });
  }
});

// Claude plugin-marketplace face (add-ecosystem-bridge 2.5): the same public
// read face, shaped as a native Claude Code marketplace.
registerMarketplaceJson(app, {
  registry,
  resolveUser,
  // Official roster — the same env/owner as the gateway mount above. Passed
  // explicitly because registry.list() summaries do not carry `official`
  // (the route layer injects it), and this face renders the adopted mark.
  officialAuthors: (process.env.OFFICIAL_AUTHOR_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
});

// MCP catalog cards (S2, design D6): read-only aggregation from the registry
// via registry-bridge — same env (REGISTRY_URL + MARKET_REGISTRY_TOKEN), same
// registry-groups visibility mapping, no registry writes ever.
//
// add-supply-store-unification: the spine store (same packs.db, new tables) is
// the one physical registration store for the skill/MCP species. When
// SUPPLY_STORE_CATALOG=1 the card face reads the spine store instead of the
// bridge snapshot — the cutover switch; default keeps the bridge until the
// migration window flips it. The store routes (projection pull source +
// write gate) mount regardless, so the registry can pull and the facade can
// forward writes before the read face switches.
const supplyStore = createSupplyStore({
  file: path.join(DATA_ROOT, "packs.db"),
  gatewayBase: (process.env.REGISTRY_URL || "").trim(),
});
registerSupplyStoreRoutes(app, {
  store: supplyStore,
  projectionToken: (process.env.SUPPLY_STORE_PROJECTION_TOKEN || "").trim(),
  writeToken: (process.env.SUPPLY_STORE_WRITE_TOKEN || "").trim(),
});
// Repo annotation source rides the spine path too (finddata-supply-
// annotations, the curated 23-entry track with source="finddata-supply-
// annotations"): the bridge merges registry metadata.annotations + the repo
// file per entry, and spine rows only carry the metadata half — the curated
// repo file must be loaded and handed to catalogMcpEntries/catalogSkillEntries
// through the same repoAnnotationFn seams the bridge contract fills. Skills
// pass the `.annotation` unwrap, matching mapSkill's merge shape. Missing or
// corrupt file → empty map → entries render unannotated, never a failure.
loadRepoAnnotations(bundledJson("market-annotations.json"));
await initFacetMcpCatalog(app, {
  resolveUser,
  ...(process.env.SUPPLY_STORE_CATALOG === "1"
    ? {
        entriesFn: () => supplyStore.catalogMcpEntries({ repoAnnotationFn: getRepoAnnotation }),
        skillsFn: () =>
          supplyStore.catalogSkillEntries({
            repoAnnotationFn: (name) => getRepoSkillAnnotation(name)?.annotation,
          }),
      }
    : {}),
});

// Unified supply catalog (add-supply-catalog-unification W1): the facade and
// data-anchor species' own source faces, projected with the production
// annotation shape. Absent config degrades to an honest empty face — the two
// TTL sources never block boot and never fabricate rows.
initSupplyCatalog(app, { resolveUser, registry });

// MCP Registry projection (add-marketplace-projection-fanout): the same public
// server set, projected to the official server.json format for mcp-publisher.
// Reads the bridge snapshot the catalog init just wired — same source, same
// visibility rule (imported, not restated), read-only.
{
  const registryBridge = await import("../registry-bridge.js");
  registerMcpRegistryJson(app, {
    entriesFn: () => registryBridge.getMarketEntries().mcpServers ?? [],
  });
}

// Machine surfaces belong to the plaza host (fix-supply-machine-faces D1):
// this shell owns none of them, and a soft 200 carrying index.html is
// indistinguishable from a real machine face to a crawler. Mounted before the
// static handler and the catch-all so nothing below can mask it.
app.use(machineSurfaceGuard());

// Static thin SPA + fallback (non-API, non-auth GETs land in the app shell).
app.use(express.static(WEB_DIST, { index: "index.html" }));
app.get(/^\/(?!api\/|auth\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, "index.html")));

await pairing.bindings.load();

app.listen(PORT, () => {
  console.log(`[facet] listening on http://127.0.0.1:${PORT} (public base ${PUBLIC_BASE})`);
  console.log(`[facet] registry at ${path.join(DATA_ROOT, "packs.db")}; login ${logtoAuth ? "enabled" : "DISABLED"}; proxy channel ${process.env.FACET_INTERNAL_TOKEN ? "armed" : "closed"}; pairing ${pairing.appAuth.configured ? "armed" : "closed"}`);
});
