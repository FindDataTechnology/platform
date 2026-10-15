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
import { createLogtoAuth } from "../server/logto-auth.js";
import { resolveSessionSecret } from "../server/session.js";
import { createResolveUser } from "./identity.js";
import { initFacetMcpCatalog } from "./mcp-catalog.js";
import { registerMarketplaceJson } from "./marketplace-json.js";
import { createFacetPairing, registerPairingRoutes, withAppBearer } from "./pairing.js";

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
    sessionAuth: logtoAuth ? (req) => logtoAuth.authenticate(req) : null,
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
  if (!user) return res.json({ email: null, groups: [], creator: false, admin: false, accessMode });
  const groups = user.groups ?? [];
  res.json({
    email: user.email,
    groups,
    creator: creatorGroups.some((g) => groups.includes(g)),
    admin: adminGroups.some((g) => groups.includes(g)),
    accessMode,
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

registerPackRoutes(app, {
  registry,
  resolveUser,
  rejectUnauthenticated,
  creatorGroups,
  adminGroups,
  anonymousRead: true,
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
registerMarketplaceJson(app, { registry, resolveUser });

// MCP catalog cards (S2, design D6): read-only aggregation from the registry
// via registry-bridge — same env (REGISTRY_URL + MARKET_REGISTRY_TOKEN), same
// registry-groups visibility mapping, no registry writes ever.
await initFacetMcpCatalog(app, { resolveUser });

// Static thin SPA + fallback (non-API, non-auth GETs land in the app shell).
app.use(express.static(WEB_DIST, { index: "index.html" }));
app.get(/^\/(?!api\/|auth\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, "index.html")));

await pairing.bindings.load();

app.listen(PORT, () => {
  console.log(`[facet] listening on http://127.0.0.1:${PORT} (public base ${PUBLIC_BASE})`);
  console.log(`[facet] registry at ${path.join(DATA_ROOT, "packs.db")}; login ${logtoAuth ? "enabled" : "DISABLED"}; proxy channel ${process.env.FACET_INTERNAL_TOKEN ? "armed" : "closed"}; pairing ${pairing.appAuth.configured ? "armed" : "closed"}`);
});
