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

import path from "node:path";
import express from "express";
import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";
import { createLogtoAuth } from "../server/logto-auth.js";
import { resolveSessionSecret } from "../server/session.js";
import { createResolveUser } from "./identity.js";
import { initFacetMcpCatalog } from "./mcp-catalog.js";
import { registerMarketplaceJson } from "./marketplace-json.js";

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

const resolveUser = createResolveUser({
  expectedToken: process.env.FACET_INTERNAL_TOKEN || "",
  sessionAuth: logtoAuth ? (req) => logtoAuth.authenticate(req) : null,
});

function rejectUnauthenticated(_req, res) {
  return res.status(401).json({ error: "Authentication required", loginUrl: "/auth/login" });
}

const registry = createPackRegistry({ file: path.join(DATA_ROOT, "packs.db") });

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "facet" }));

// Identity probe for the SPA header.
app.get("/api/whoami", (req, res) => {
  const user = resolveUser(req);
  res.json(user ? { email: user.email, groups: user.groups ?? [] } : { email: null, groups: [] });
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

registerPackRoutes(app, {
  registry,
  resolveUser,
  rejectUnauthenticated,
  creatorGroups: splitGroups(process.env.PACK_CREATOR_GROUPS, "creators"),
  adminGroups: splitGroups(process.env.ADMIN_GROUPS, ""),
  anonymousRead: true,
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

app.listen(PORT, () => {
  console.log(`[facet] listening on http://127.0.0.1:${PORT} (public base ${PUBLIC_BASE})`);
  console.log(`[facet] registry at ${path.join(DATA_ROOT, "packs.db")}; login ${logtoAuth ? "enabled" : "DISABLED"}; proxy channel ${process.env.FACET_INTERNAL_TOKEN ? "armed" : "closed"}`);
});
