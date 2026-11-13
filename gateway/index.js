#!/usr/bin/env node
// ── Cloud gateway ────────────────────────────────────────────────────────────
//
// The hosted deployment's only reachable surface. It authenticates every
// request through Logto, routes each session to the requesting user's cell
// (starting one on that user's first traffic), and reverse-proxies HTTP and
// WebSocket traffic there with the verified identity injected.
//
// It holds no per-user data — everything stateful lives in the cells it
// starts, which is what keeps the blast radius of a bug here small and the
// Phase 3 swap (a k8s client in place of the spawner) contained.
//
//   node gateway/index.js        # see .env.example, "Hosted cells"

import "dotenv/config";
import express from "express";
import http from "node:http";
import path from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLogtoAuth } from "../server/logto-auth.js";
import { resolveSessionSecret, verifyEmbedToken } from "../server/session.js";
import { applySpaHeaders, SHELL_CACHE_CONTROL } from "../lib/spa-static-headers.js";
const sessionHelpers = { verifyEmbedToken };
import { createCellRegistry, userIdFor } from "./spawner.js";
import { createCellRegistryDb } from "./cell-registry.js";
import { createDutyRing } from "./duty-ring.js";
import { createCellReportDoor, createDesiredFleetDoor } from "./cell-report.js";
import { createFleetMachinesStore } from "./fleet-machines-store.js";
import { registerFleetMachineRoutes } from "./fleet-machines-routes.js";
import { rm } from "node:fs/promises";
import { forwardedHeaders, machineHeaders, proxyHttp, proxyUpgrade } from "./proxy.js";
import { decideMandateDoor, MANDATE_OWNER_HEADER, MANDATE_VERDICT_PATH } from "./mandate-door.js";
import { decideInputRequestDoor, INPUT_REQUEST_MCP_PATH, INPUT_REQUEST_OWNER_HEADER } from "./input-request-door.js";
import { registerLineExchange } from "./line-token-exchange.js";
import { createSub2apiClient } from "../lib/sub2api-admin.js";
import { createMpAuth } from "./mp-auth.js";
import { createMpBindings } from "./mp-bindings.js";
import { renderBindCodePage } from "./mp-bind-page.js";
import { createAppAuth } from "./app-auth.js";
import { createShareRegistry, createRateLimiter } from "./share.js";
import { createPackRegistry, registerPackRoutes } from "./packs.js";
import { registerVendorRoutes } from "./vendors.js";
import { registerOnboardingRoutes } from "./vendor-onboarding.js";
import { registerMarketRoutes } from "./market.js";
import { registerFacetProxy } from "./facet-proxy.js";
import { createRoleStore, makeIsAdminUser } from "./roles.js";
import { createLayoutStore } from "./layout.js";
import { GATEWAY_SECRET_HEADER, secretMatches } from "../server/auth.js";
import { registerErpProxyRoutes } from "../server/routes/erp-proxy.js";
import { isBusinessRole } from "../server/roles.js";
// wanxing mount 摘挂（unify-wanxing-a2a-face 4.x）：卡片/目录/管理路由的唯一出面
// 是萬星 facade（wanxing.finddatatech.cloud，fd-wanxing 仓）；platform 域不再挂载。
import { registerZhiyuRoutes } from "./zhiyu/index.js";
import { createVoiceRoute } from "./zhiyu/voice-route.js";
import { registerFleetRoomBridge } from "./fleet-room-bridge.js";
import { createZhiyuAgentLane } from "./zhiyu/agent-lane.js";
import { createCellFleetReporter } from "./fleet-cells.js";
import { registerOwnerCellsRoute } from "./fleet-board.js";
import { registerMemoryFaceRoute } from "./memory-face.js";
import { createBrowserLaneHealthProbe } from "../lib/browser-lane-health.js";
import { createProcMemorySampler } from "../lib/proc-memory.js";
import { createBotWebhookRouter } from "./bot-webhooks.js";
import Database from "better-sqlite3";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.GATEWAY_PORT || 3080);
// The gateway IS the public surface, so it binds where the proxy/ingress can
// reach it. The cells it starts are loopback-only regardless.
const HOST = process.env.GATEWAY_HOST || "0.0.0.0";
const SECRET = String(process.env.CELL_GATEWAY_SECRET || "");
const DATA_ROOT = path.resolve(process.env.CELL_DATA_ROOT || "cell-data");
// 0 = never reap: cells stay resident once started (the default contract).
const IDLE_REAP_SECS = Number(process.env.CELL_IDLE_REAP_SECS || 0);
const START_TIMEOUT_MS = Number(process.env.CELL_START_TIMEOUT_MS || 60_000);
const startedAt = Date.now();

if (!SECRET) {
  console.error("[gateway] CELL_GATEWAY_SECRET is required — cells reject identity headers without it");
  process.exit(1);
}

const logtoAuth = await createLogtoAuth({
  AUTH_MODE: "logto",
  LOGTO_ENDPOINT: process.env.LOGTO_ENDPOINT || "",
  LOGTO_APP_ID: process.env.LOGTO_APP_ID || "",
  LOGTO_APP_SECRET: process.env.LOGTO_APP_SECRET || "",
  LOGTO_CLIENT_TYPE: process.env.LOGTO_CLIENT_TYPE || "confidential",
  LOGTO_END_SESSION: process.env.LOGTO_END_SESSION || "false",
  SESSION_TTL_HRS: process.env.SESSION_TTL_HRS || "24",
  PAAS_BASE_URL: process.env.PAAS_BASE_URL || "",
  resolveSessionSecret: () => resolveSessionSecret({ env: process.env }),
});

// add-cell-lifecycle 3.x: the durable store, constructed once and shared by
// the spawner (spawn/suspend/destroy beats) and the duty ring (wake). A
// rolled gateway rebuilds the demand surface from it — rolling no longer
// silences fleets until their owners return. CELL_REGISTRY_DISABLE=1 keeps
// the byte-for-byte legacy world (tests pinning the old spawner behavior).
const cellRegistryDb = process.env.CELL_REGISTRY_DISABLE === "1"
  ? null
  : createCellRegistryDb({ file: path.join(DATA_ROOT, "cells-registry.db") });

// Memory admission floor (harden-platform-memory-carrier): ONE threshold read
// shared by the spawner's residency gate and the /api/monitoring/memory face,
// so what the cockpit ambers against is exactly what the gate enforces. 0
// disables the gate entirely.
const CELL_MEMORY_FLOOR = Number(process.env.CELL_MEMORY_ADMISSION_FLOOR ?? 0.15);
// Default wake footprint (add-wake-budget-admission): the contribution booked
// for a residency with NO archived footprint (first provision, first wake
// after a hard kill). 0 disables the default — such wakes degrade to the
// legacy current-only judgment. Byte-counted in the same ledger as archives.
const CELL_WAKE_DEFAULT_FOOTPRINT_MB = Number(process.env.CELL_WAKE_DEFAULT_FOOTPRINT_MB ?? 512);
// Footprint TTL (fix-stale-wake-footprint): how long an archived wake footprint
// stays authoritative. Past this age the archive is ignored and the wake is
// judged on the default footprint (then re-measured at the next park) — without
// it a high-water mark from a heavier era permanently refuses the very wake that
// would refresh it. 0 disables expiry.
const CELL_FOOTPRINT_TTL_MS = Number(process.env.CELL_FOOTPRINT_TTL_MS ?? 6 * 60 * 60 * 1000);
// One sampler for the whole process: the gate, the read face, and any future
// reader share one TTL-cached /proc scan (高频请求不放大扫描开销).
// Shared browser lane reachability (slim-browser-lane-footprint 3.2): once the
// lane is one pod-level service, "is the browser lane up?" can only be answered
// by the service itself. Unconfigured deployments (desktop, single-process)
// report configured:false and every face simply omits the row.
const browserLaneProbe = createBrowserLaneHealthProbe({ env: process.env });

const procMemorySampler = createProcMemorySampler({
  ttlMs: Number(process.env.CELL_MEMORY_SAMPLE_TTL_MS || 2000),
});

// Live proxied WebSockets per cell, owned HERE because the gateway is what
// accepts them. The idle reaper reads it through `isActive` below: a chat sits
// on its socket without issuing any HTTP request, so counting traffic alone
// reaped cells mid-turn (and, with a short window, mid-boot).
const liveSockets = new Map();

const registry = createCellRegistry({
  dataRoot: DATA_ROOT,
  secret: SECRET,
  startTimeoutMs: START_TIMEOUT_MS,
  idleReapSecs: IDLE_REAP_SECS,
  isActive: (cellId) => (liveSockets.get(cellId) ?? 0) > 0,
  // Residency memory gate (harden-platform-memory-carrier): refuse new
  // residency below the floor; metrics failure fails open inside the spawner.
  procMemory: procMemorySampler,
  memoryFloor: CELL_MEMORY_FLOOR,
  wakeDefaultFootprintMb: CELL_WAKE_DEFAULT_FOOTPRINT_MB,
  footprintTtlMs: Number.isFinite(CELL_FOOTPRINT_TTL_MS) ? CELL_FOOTPRINT_TTL_MS : 6 * 60 * 60 * 1000,
  // Demo-cell bounds (openspec: mp-demo-mode): how many demo cells may run at
  // once, and how idle one may sit before it is stopped AND deleted —
  // independent of the account-cell contract above.
  demoMaxCells: Number(process.env.MP_DEMO_MAX_CELLS || 3),
  demoIdleReapSecs: Number(process.env.MP_DEMO_IDLE_SECS || 900),
  // CELL_SERVER_ENTRY defaults to the real cell; tests point it at a stub so
  // the identity/routing contract can be exercised without booting dsh.
  serverEntry: process.env.CELL_SERVER_ENTRY || path.join(REPO, "server.js"),
  // Cells run with a per-user cwd under their own data root; bundled read-only
  // code and assets resolve from the image via repoRoot() (paths.js), and their
  // writes are confined to their own data root (proven by
  // scripts/test-cell-containment.mjs).
  env: process.env,
  ...(cellRegistryDb ? { registryDb: cellRegistryDb, initialPolicy: "on_demand" } : {}),
});

// Duty ring (add-cell-lifecycle 3.2): suspended on_demand cells wake when
// their persisted schedules come due — the cron-exemption that used to pin
// every fleet cell resident is superseded (spec 3.4 transition bridge).
// Decisions read persistence only; spawning stays spawner's business.
const dutyRing = cellRegistryDb
  ? createDutyRing({
      registryDb: cellRegistryDb,
      dataRoot: DATA_ROOT,
      ensure: (user) => registry.ensure(user),
      spawnGate: Number(process.env.CELL_DUTY_SPAWN_GATE || 4),
      tickMs: Number(process.env.CELL_DUTY_TICK_MS || 60_000),
    })
  : null;
dutyRing?.start();

// Cell fleet telemetry (unify-wanxing-management-plane): read-only short-term
// execution visibility for the 萬星 board. The gateway samples each live
// cell's task stats and relays cell_stats to the fleet ingest — inert without
// FLEET_INGEST_URL/TOKEN (zero behavior change), and one-directional by
// construction: no control action rides this channel into a cell.
const cellFleetReporter = createCellFleetReporter({ registry, secret: SECRET });
if (cellFleetReporter) {
  console.log("[gateway] cell fleet telemetry armed (FLEET_INGEST_URL)");
}

// ── Mini-program identity (second front door) ──────────────────────────────
// Account-binding model: a WeChat openid is bound to a platform (Logto)
// account on first sign-in; every later launch exchanges a fresh wx.login
// code for a platform JWT carrying the ACCOUNT identity (same email/groups
// as the web session → same cell, shared data). Inert (login reports
// not-configured, Bearer never verifies) until MP_APPID/MP_SECRET/
// MP_TOKEN_SECRET are set — the Logto browser flow is unaffected either way.
const mpBindings = createMpBindings({ file: path.join(DATA_ROOT, "mp-bindings.json") });
await mpBindings.load();

const mpAuth = createMpAuth({
  appid: process.env.MP_APPID || "",
  mpSecret: process.env.MP_SECRET || "",
  tokenSecret: process.env.MP_TOKEN_SECRET || "",
  ttlHours: Number(process.env.MP_TOKEN_TTL_HOURS || 12),
  codeUrl: process.env.MP_JS_CODE_URL || "https://api.weixin.qq.com/sns/jscode2session",
  bindings: mpBindings,
  // Demo mode (openspec: mp-demo-mode): unbound openids get a bounded demo
  // identity instead of binding_required, so a WeChat reviewer can chat with
  // zero popups. Default off — self-hosted deployments stay strictly
  // account-bound.
  demoMode: ["1", "true", "yes"].includes(String(process.env.MP_DEMO_MODE || "").toLowerCase()),
});

// App device pairing (openspec: add-device-pairing-auth): the universal
// client's identity path. Shares the binding store, the bind-code pool and
// the token secret with the mini program above — an app token verifies
// through mpAuth.verifyToken in resolveUser exactly like an MP token, so
// cell routing is untouched. Inert (503s, capabilities omit the flag) until
// MP_TOKEN_SECRET is set.
const appAuth = createAppAuth({
  tokenSecret: process.env.MP_TOKEN_SECRET || "",
  ttlHours: Number(process.env.MP_TOKEN_TTL_HOURS || 12),
  bindings: mpBindings,
});

const app = express();
const server = http.createServer(app);

// Login, callback, logout. The gateway is the sole Logto client in this
// deployment; cells never talk to the identity provider.
logtoAuth.register(app);

// Browsers get sent to login; anything programmatic gets a 401 it can act on.
// The path decides, not `Accept`: a fetch with `Accept: */*` still "accepts"
// HTML, so content negotiation alone would answer JSON clients with a redirect.
function rejectUnauthenticated(req, res) {
  const programmatic = req.path.startsWith("/api/") || req.path.startsWith("/external/");
  if (!programmatic && req.accepts("html")) return res.redirect("/auth/login");
  return res.status(401).json({ error: "Authentication required" });
}

// Identity resolution: a verified Logto browser session (cookie), or — for
// mini-program clients — a platform JWT minted by /api/mp/login (silent, for
// a bound openid) or /api/mp/login-account (first sign-in, binds the openid
// to the Logto account). Both produce the same user shape and flow through
// the same cell mapping; the cell never learns which door the user came
// through beyond the email it receives.
function resolveUser(req) {
  const cookieUser = logtoAuth.userFromCookie(req.headers.cookie);
  if (cookieUser) return cookieUser;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    // Credential-domain polity (add-cell-lifecycle 4.1): steward-kind device
    // tokens authenticate on the REPORTING DOOR ONLY — never as a user
    // session on any gateway-routed surface (found live: steward token
    // answered 200 on /api/auth/me before this filter).
    const session = appAuth.sessionEligibleToken(auth.slice(7));
    if (session) return session;
  }
  return null;
}

// Anonymous deployment config (add-login-hero 6.2). The pre-login page reads
// GET /api/config to render branding (company name, icon, footer, and the
// loginHero slots) BEFORE it has any identity — that is the whole point of
// the branding surface. The catch-all below would 401 this route, so the
// gateway answers it directly from env, mirroring the cell's stored→env→null
// resolution for the env half. Deployment-level values only: nothing here is
// per-user, which is why it is safe to serve anonymously.
//
// Authenticated requests fall through to the cell (next()), which owns the
// stored branding — and whose boot-on-first-request behavior the routing
// contract depends on.
function brandingEnv(envName) {
  return (process.env[envName] || "").trim() || null;
}
function loginHeroEnv() {
  const raw = (process.env.LOGIN_HERO || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    console.warn("[gateway] LOGIN_HERO is not valid JSON; ignoring");
    return null;
  }
}
app.get("/api/config", (req, res, next) => {
  if (resolveUser(req)?.email) return next();
  res.json({
    documentsEnabled: true,
    packMarketplace: process.env.PACK_MARKETPLACE === "1",
    assistantName: brandingEnv("ASSISTANT_NAME"),
    companyName: brandingEnv("COMPANY_NAME"),
    brandIconUrl: brandingEnv("BRAND_ICON_URL"),
    loginFooterText: brandingEnv("LOGIN_FOOTER_TEXT"),
    loginHero: loginHeroEnv(),
    // Capability probe for non-browser clients (add-device-pairing-auth):
    // absent on older deployments, which clients read as "unsupported" and
    // degrade. devicePairing rides the same MP_TOKEN_SECRET gate as the
    // mini-program path — one secret, two client kinds.
    capabilities: { devicePairing: Boolean(process.env.MP_TOKEN_SECRET) },
  });
});

// Anonymous identity introspection. The SPA calls this before it has a
// session to decide between the login page and the app; a 401 here reads as
// "auth is not configured", which would send visitors straight into the chat
// shell. Answers the anonymous shape (mode "logto", authenticated false) so
// the login page renders with its SSO entry. A request that DOES carry a
// session falls through to the cell: the first authenticated request is what
// boots a user's cell, so short-circuiting here would leave it unstarted.
app.get("/api/auth/me", (req, res, next) => {
  if (resolveUser(req)?.email) return next();
  res.json({
    mode: "logto",
    email: null,
    groups: null,
    authenticated: false,
    adminGroups: ADMIN_GROUPS,
    loginUrl: "/auth/login",
    logoutUrl: "/api/auth/logout",
    ssoConfigured: false,
    ssoAuthenticated: false,
    ssoEmail: null,
    ssoGroups: null,
  });
});

// ── ERP 纵向服务面同源入口（add-erp-supply-chain-gateway-proxy）──────────────
// 产上 origin 端口 3100 由**本网关**持有（Deployment 里 command 是
// `node gateway/index.js`；server.js 是网关派生的 cell 子进程，收不到这个前缀）。
// 首轮上产就是这么漏的：代理挂在 server.js 里、单测全绿、镜像里文件也在，但
// `GET /erp/supply-chain/v1/pagesets` 返回的却是下面 SPA 兜底吐出的 index.html
// （1298 字节）。所以挂载点必须在网关，且必须早于静态资源/SPA 兜底那两行。
// 身份：网关自己解出的会话由 resolveUser 落成 req.user；客户端自带的 X-ERP-* 一律剥离。
registerErpProxyRoutes({ app, resolveUser });

// ── Pre-login SPA shell (add-login-hero 6.2) ───────────────────────────────
// Registered just before the identity catch-all (below), after every concrete
// route — /healthz and the /api/* routes must not be swallowed by the SPA
// fallback. The React app decides for itself whether to show the login page
// (it reads /api/auth/me and /api/config, both reachable anonymously) — but
// only if it can load. Without these routes the catch-all redirects every
// request, including the bundle itself, straight to the hosted Logto page, so
// the product's own login surface is unreachable on a hosted deployment.
const WEB_DIST = path.join(REPO, "web", "dist");
// Cache posture (openspec: harden-spa-shell-resilience): the shell always
// revalidates, content-hashed build output lives forever — one leaf module
// owns the rule so the single-process server cannot drift from it.
app.use(express.static(WEB_DIST, { setHeaders: (res, filePath) => applySpaHeaders(res, filePath) }));
// zhiyu/embed + zhiyu/join + zhiyu/widget are gateway-served lanes with their
// OWN headers (dynamic CSP, loader MIME) — the SPA fallback must not swallow
// them before the zhiyu module answers. The member-facing /zhiyu page route
// stays on the SPA fallback in the same breath.
app.get(/^\/(?!api\/|external\/|auth\/|healthz$|readyz$|assets\/|zhiyu\/embed\/|zhiyu\/join\/|zhiyu\/widget).*/, (_req, res) => {
  res.sendFile(path.join(WEB_DIST, "index.html"), { headers: { "Cache-Control": SHELL_CACHE_CONTROL } });
});

// Bind-code minting for the web side: an authenticated BROWSER session (the
// Logto cookie) gets a 6-digit, single-use, 5-minute code to type into the
// mini program once. Browsers get a small human-readable page; programmatic
// clients (Accept: application/json) get JSON. No Logto internals involved —
// this is the gateway's own session doing the proving.
app.get("/api/mp/bindcode", async (req, res) => {
  const user = resolveUser(req);
  if (!user) return rejectUnauthenticated(req, res);
  const { code, ttlMs } = mpBindings.issueBindCode(user.email, user.groups ?? []);
  if (req.accepts("json") && !req.accepts("html")) {
    return res.json({ code, ttlMs });
  }
  res.type("html").send(renderBindCodePage({ code, email: user.email }));
});

// Mini-program silent login: wx.login code in, platform JWT out. A 404 with
// `binding_required` tells the client this openid has no bound account yet
// and it should show the login page. The WeChat appid/secret and the
// session key never leave this process.
app.post("/api/mp/login", express.json(), async (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const r = await mpAuth.login(code);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ token: r.token, email: r.email });
});

// Mini-program first sign-in: a fresh wx.login code + a bind code minted
// from the account's web session. Redeems the code, binds the openid to the
// account, returns the same platform JWT the silent path issues.
app.post("/api/mp/login-bindcode", express.json(), async (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const bindCode = typeof req.body?.bindCode === "string" ? req.body.bindCode : "";
  const r = await mpAuth.loginWithBindCode(code, bindCode);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ token: r.token, email: r.email });
});

// Mini-program logout: removes the openid⇄account binding behind the
// presented token. The next launch asks for credentials again.
app.delete("/api/mp/bind", async (req, res) => {
  const auth = req.headers.authorization;
  const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const r = await mpAuth.unbind(token);
  if (!r.ok) return res.status(r.status).json({ error: "Invalid token" });
  res.json({ ok: true });
});

// ── App device pairing (openspec: add-device-pairing-auth) ──────────────────
// The universal client's five doors. pair/challenge/login authenticate
// themselves (bind code / device key) and need no session. devices/revoke
// take any resolveUser identity — a browser cookie OR an app Bearer token
// (which carries the account email), so the app's Settings can list and
// unbind its own device without a browser nearby.
// Steward reporting + desired-state doors (add-cell-lifecycle 4.2,
// add-unified-fleet-console): the steward-kind device credential opens
// exactly these two doors — the whitelisted reporting shapes (presence /
// manifest relay onward; detail lands in the machines store only) and the
// self-scoped desired-state pull. The machines store backs the web machines
// console with the same JSON-file convention as mp-bindings.
const fleetMachinesStore = createFleetMachinesStore({ file: path.join(DATA_ROOT, "fleet-machines.json") });
await fleetMachinesStore.load();
const cellReportDoor = createCellReportDoor({ appAuth, machines: fleetMachinesStore });
app.post("/api/gateway/cell-report", express.json(), (req, res) => void cellReportDoor.handle(req, res));
const desiredFleetDoor = createDesiredFleetDoor({ appAuth, machines: fleetMachinesStore });
app.get("/api/gateway/desired-fleet", (req, res) => void desiredFleetDoor.handle(req, res));
registerFleetMachineRoutes({
  app,
  appAuth,
  machines: fleetMachinesStore,
  callerEmail: (req) => resolveUser(req)?.email ?? null,
  isAdmin: (req) => isAdminUser(resolveUser(req)),
});

app.post("/api/app/pair", express.json(), async (req, res) => {
  const r = await appAuth.pair(req.body ?? {});
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ token: r.token, email: r.email });
});

app.post("/api/app/challenge", express.json(), (req, res) => {
  const r = appAuth.challenge(req.body ?? {});
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ nonce: r.nonce, ttlMs: r.ttlMs });
});

app.post("/api/app/login", express.json(), (req, res) => {
  const r = appAuth.login(req.body ?? {});
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ token: r.token, email: r.email });
});

app.get("/api/app/devices", (req, res) => {
  const user = resolveUser(req);
  if (!user) return rejectUnauthenticated(req, res);
  res.json(appAuth.devicesFor(user.email));
});

app.delete("/api/app/bind/:deviceId", async (req, res) => {
  const user = resolveUser(req);
  if (!user) return rejectUnauthenticated(req, res);
  const r = await appAuth.revoke(user.email, String(req.params?.deviceId ?? ""));
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true });
});

// Liveness. Public by design — a probe has no session cookie — and it reports
// no per-user information.
app.get("/healthz", async (_req, res) => {
  // The shared browser lane is a pod-level dependency now, so it belongs in
  // liveness: reachable=false is visible, while /healthz itself stays 200 (a
  // dead browser lane must not take the whole platform out of rotation).
  const lane = browserLaneProbe.configured ? await browserLaneProbe.probe() : null;
  // Crash visibility without log grepping: how many cells are sitting in the
  // error state right now, and how many total crashes the ledger has counted.
  const cellsInError = [...registry.cells.values()].filter((c) => c.state === "error").length;
  let crashTotal = null;
  try {
    crashTotal = cellRegistryDb
      ? cellRegistryDb.all().reduce((n, r) => n + Number(r.crashCount ?? 0), 0)
      : null;
  } catch { /* ledger unreadable must not take liveness down */ }
  res.json({
    ok: true,
    uptimeMs: Date.now() - startedAt,
    cells: registry.cells.size,
    ...(crashTotal ? { crashTotal } : {}),
    cellsInError,
    ...(lane ? { browserLane: { reachable: lane.reachable, url: lane.url } } : {}),
  });
});

// ── /readyz: readiness that can actually see the queue ────────────────────
//
// Why a new endpoint instead of reusing /api/ready: /api/ready lives in the
// CELL and the gateway gates every /api/* request (measured 2026-11-08 —
// `curl 127.0.0.1:3100/api/ready` from inside the pod returned 401, even though
// the cell's own auth exempts it). A k8s probe can only read what the gateway
// answers, and /healthz reports cells/crashes but nothing about backlog.
//
// Semantics, deliberately conservative:
//   - 200 unless some resident cell reports `degraded` (its own threshold logic)
//   - a cell that cannot be asked is UNKNOWN, not failed: the probe must not
//     take the platform out of rotation because one cell is slow to answer
//   - short timeout, per-cell, in parallel; the whole probe is bounded
//   - 503 body carries the aggregate so the reason is visible, not a bare code
app.get("/readyz", async (_req, res) => {
  const running = [...registry.cells.values()].filter((c) => c.state === "running" && c.port);
  const summarized = await Promise.all(running.map(async (cell) => {
    try {
      const r = await fetch(`http://127.0.0.1:${cell.port}/api/gateway/queue`, {
        headers: { "x-forwarded-email": cell.email, "x-cloud-gateway-secret": SECRET },
        signal: AbortSignal.timeout(2000),
      });
      if (!r.ok) return { cell: cell.userId, unknown: `http ${r.status}` };
      const q = await r.json();
      return {
        cell: cell.userId,
        queued: q.queued,
        running: q.running,
        oldestQueuedMs: q.oldestQueuedMs,
        degraded: q.degraded === true,
      };
    } catch (e) {
      return { cell: cell.userId, unknown: e?.name === "AbortError" ? "timeout" : String(e?.message || e) };
    }
  }));
  const known = summarized.filter((c) => !c.unknown);
  const queued = known.reduce((n, c) => n + (c.queued ?? 0), 0);
  const oldestQueuedMs = known.reduce((m, c) => Math.max(m, c.oldestQueuedMs ?? 0), 0) || null;
  const degradedCells = known.filter((c) => c.degraded).map((c) => c.cell);
  // `?probe=alive`：给 k8s 探针用的**存活**判据，与"堵着"分开。
  //
  // 为什么需要它（2026-11-09 实测）：默认的 ready 语义是「有任何 cell 报 degraded
  // 就 503」，而 degraded 由积压驱动。那天平台因为一条长回合排在 5 个人点轮前面，
  // `/readyz` 连续 503 了约 40 分钟——**期间平台服务完全正常**。把这个 503 直接
  // 接成 readinessProbe，等于在最不该摘流量的时候把整个平台摘出 Service。
  //
  // 所以探针该问的是"这一层还活着吗"：至少有**一个** cell 答上来就算活；
  // 全都答不上（registry 空、或全部超时）才是 dead。积压仍留在默认响应里给人和
  // 告警读，不参与摘流量。
  const aliveOnly = String(_req.query?.probe || "") === "alive";
  const ready = aliveOnly ? known.length > 0 || running.length === 0 : degradedCells.length === 0;
  res.status(ready ? 200 : 503).json({
    ready,
    ...(aliveOnly ? { probe: "alive" } : {}),
    cells: running.length,
    answered: known.length,
    unknown: summarized.filter((c) => c.unknown).map(({ cell, unknown }) => ({ cell, reason: unknown })),
    queued,
    oldestQueuedMs,
    degradedCells,
  });
});

// The admin group name(s) — see registerAuth's ADMIN_GROUPS for the rationale
// (per-product Logto org-role names). The gateway runs its own process, so it
// reads the same env directly.
const ADMIN_GROUPS = (process.env.ADMIN_GROUPS || "admin")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Admin composition (role-system D3): the admin group OR the stored admin
// flag. The flag lives in the role store, so the predicate is built with it.
const roleStore = createRoleStore({
  file: path.join(DATA_ROOT, "roles.json"),
  env: process.env,
});
const layoutStore = createLayoutStore({
  file: path.join(DATA_ROOT, "layout.json"),
  env: process.env,
});
const isAdminUser = makeIsAdminUser({ adminGroups: ADMIN_GROUPS, store: roleStore });

// ── Business roles (role-system) ────────────────────────────────────────────
// Answered at the gateway (before the cell-proxy catch-all): assignments are
// deployment-level, so the admin surface and the headers cells receive must
// come from one store regardless of which cells are running. Registered for
// the /api/roles prefix only — every other route still falls through to the
// owning cell.
app.get("/api/roles", (req, res) => {
  const user = resolveUser(req);
  if (!user) return rejectUnauthenticated(req, res);
  res.json({ roles: roleStore.roles, default: "standard" });
});

app.get("/api/roles/assignments", (req, res) => {
  const user = resolveUser(req);
  if (!user) return rejectUnauthenticated(req, res);
  if (!isAdminUser(user)) return res.status(403).json({ error: "Admin group required" });
  res.json({ assignments: roleStore.list(), default: roleStore.getDefault().default });
});

app.put("/api/roles/assignments/:userId", express.json(), (req, res) => {
  const user = resolveUser(req);
  if (!user) return rejectUnauthenticated(req, res);
  if (!isAdminUser(user)) return res.status(403).json({ error: "Admin group required" });
  const result = roleStore.set(req.params.userId, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ email: String(req.params.userId).trim().toLowerCase(), ...result.assignment });
});

// Self-service role write (intent-onboarding). A hosted deployment's
// assignments live in THIS store — the gateway stamps x-forwarded-roles from it
// on every request, so the cell's own copy never reaches the browser. The cell
// posts here with its gateway secret (it is the only caller that knows the
// answer was validated) and this route writes WITHOUT the admin gate, because
// the whole point is that a user may choose their own business roles. Two
// invariants make that safe, both enforced in the store rather than trusted
// from the caller:
//   * the target is the CALLER's own identity — a cell cannot assign roles to
//     anyone else;
//   * the admin flag is preserved verbatim and never granted (setSelf).
app.post("/api/roles/self", express.json(), (req, res) => {
  // The cell authenticates with the shared secret, not a browser session —
  // this is the internal half of the same identity channel the cells verify.
  const provided = req.headers[GATEWAY_SECRET_HEADER];
  if (!secretMatches(provided, SECRET)) return res.status(401).json({ error: "Authentication required" });
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "email is required" });
  const roles = Array.isArray(req.body?.roles) ? req.body.roles.filter(isBusinessRole) : [];
  if (!roles.length) return res.status(400).json({ error: "at least one business role is required" });
  const result = roleStore.setSelf(email, { primary: roles[0], secondary: roles.slice(1) });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ email, ...result.assignment });
});

// ── Workbench layout (layout-configuration) ─────────────────────────────────
// Deployment-level, answered here for the same reason roles are: the document
// must be one regardless of which cells are running. The cell resolves the
// user's final layout (it owns the user's tweaks) from the headers this layer
// ships plus its own stored copy; the admin face edits the deployment layer.
app.get("/api/layout/config", (req, res) => {
  const user = resolveUser(req);
  if (!user) return rejectUnauthenticated(req, res);
  if (!isAdminUser(user)) return res.status(403).json({ error: "Admin group required" });
  res.json(layoutStore.config());
});

app.put("/api/layout/config", express.json(), (req, res) => {
  const user = resolveUser(req);
  if (!user) return rejectUnauthenticated(req, res);
  if (!isAdminUser(user)) return res.status(403).json({ error: "Admin group required" });
  const result = layoutStore.set(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.config);
});

// Per-user cell status for operators. Same identity check as everything else,
// plus the admin group: the list of users on this deployment is deployment
// information, not something any signed-in user should be able to enumerate.
app.get("/api/gateway/status", async (req, res) => {
  const user = logtoAuth.userFromCookie(req.headers.cookie);
  if (!user) return rejectUnauthenticated(req, res);
  if (!isAdminUser(user)) return res.status(403).json({ error: "Admin group required" });
  // Cell rows carry their disk budget view (budget-cell-disk-usage 2.1); the
  // readings are TTL-cached, so this stays one walk per cell per window.
  const cellStatus = await registry.statusWithDisk();
  res.json({
    cells: cellStatus,
    demoCells: cellStatus.filter((c) => c.demo).length,
    idleReapSecs: IDLE_REAP_SECS,
    dataRoot: DATA_ROOT,
    uptimeMs: Date.now() - startedAt,
    ...(cellRegistryDb ? { registryRows: cellRegistryDb.all().length } : {}),
  });
});

// Operator-driven cell destroy (add-cell-lifecycle 3.3): refuse over live
// work unless forced, stop the cell, remove its data root, and leave a
// tombstone that suppresses every future spawn/wake for this user (spec:
// destroyed traffic must not respawn the cell until the row is cleared).
app.delete("/api/gateway/cells/:userId", async (req, res) => {
  const user = logtoAuth.userFromCookie(req.headers.cookie);
  if (!user) return rejectUnauthenticated(req, res);
  if (!isAdminUser(user)) return res.status(403).json({ error: "Admin group required" });
  if (!cellRegistryDb) return res.status(503).json({ error: "cell registry disabled" });
  const userId = req.params.userId;
  const row = cellRegistryDb.get(userId);
  const live = registry.cells.get(userId);
  const force = req.query.force === "1" || req.query.force === "true";
  if (!row && !live) return res.status(404).json({ error: "cell not found" });
  if (live && live.state === "running" && !force) {
    return res.status(409).json({ error: "cell has a live process; retry with ?force=1 to stop it" });
  }
  if (live) registry.stop(userId, force ? "operator destroy (forced)" : "operator destroy");
  // The durable beat: tombstone BEFORE data removal, so a crash mid-way
  // still suppresses respawn — the root is re-removed idempotently on retry.
  registryDbFire(cellRegistryDb, userId, { type: "destroyRequested", reason: `operator:${user.email}`, now: Date.now() });
  try {
    await rm(path.join(DATA_ROOT, userId), { recursive: true, force: true });
  } catch (e) {
    return res.status(500).json({ error: `data root removal failed: ${e.message}` });
  }
  res.json({ destroyed: true, userId, force });
});

function registryDbFire(db, cellId, event) {
  try {
    db.fire(cellId, event);
  } catch (e) {
    console.warn(`[gateway] registry destroy write failed for ${cellId}: ${e?.message || e}`);
  }
}

// ── Session sharing (openspec: add-session-share) ───────────────────────────
// The gateway brokers every share: it mints tokens for authenticated owners
// (validating the session through the owner's own cell) and serves the public
// read by re-entering the registry with the OWNER's stored identity — so a
// share of a demo cell re-spawns that demo cell on demand. Cells stay
// unaware of sharing; they only ever see a normal identity-headered request
// for their chat-history REST.
const shareRegistry = createShareRegistry({ file: path.join(DATA_ROOT, "share-tokens.db") });
// SHARE_RATE_MAX is a test/ops knob; the shipped default is 30 reads/min.
const shareRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: Number(process.env.SHARE_RATE_MAX || 30),
});
// Every unredeemable token gets this exact response — unknown, revoked,
// expired, and since-deleted sessions are indistinguishable to a prober.
const SHARE_UNAVAILABLE = { error: "Share not available" };

// GET a session's mirrored turns from a user's cell, impersonating that user
// via the gateway's verified-identity headers (the only identity path a cell
// trusts). The cell is ensured (started) on demand — the same path serves
// create-time validation (caller's own identity) and the public read (the
// OWNER's stored identity). One self-heal retry: a cell process that died
// out from under the gateway leaves a stale record; the first read then
// fails to connect, so drop the record and re-ensure (a fresh spawn) before
// giving up.
async function readSessionFromCell(user, sessionId) {
  let attempt = 0;
  for (;;) {
    let cell;
    try {
      cell = await registry.ensure(user);
    } catch (err) {
      if (err.code === "demo_capacity") return { status: 503, error: err.friendly };
      console.error(`[share] cell start failed for ${userIdFor(user.email)}: ${err.message}`);
      return { status: 0, error: err.message };
    }
    const r = await new Promise((resolve) => {
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: cell.port,
          method: "GET",
          path: `/api/chat-history/sessions/${encodeURIComponent(sessionId)}`,
          headers: forwardedHeaders({ headers: {} }, user, SECRET),
          timeout: 15_000,
        },
        (up) => {
          let raw = "";
          up.setEncoding("utf8");
          up.on("data", (c) => (raw += c));
          up.on("end", () => {
            let body = null;
            try {
              body = JSON.parse(raw);
            } catch {
              /* non-JSON */
            }
            resolve({ status: up.statusCode, body });
          });
        },
      );
      upstream.on("timeout", () => upstream.destroy(new Error("cell timeout")));
      upstream.on("error", (err) => resolve({ status: 0, error: err.message }));
      upstream.end();
    });
    if (r.status !== 0 || attempt > 0) return r;
    attempt += 1;
    console.log(`[share] cell for ${userIdFor(user.email)} unreachable (${r.error}) — respawning`);
    // Stop the recorded process, not merely forget it: drop() alone would
    // leave a live (possibly wedged) cell holding the data root while the
    // re-ensure below spawns a second one for the same user. stop() signals
    // it, and its exit handler removes the record once the process is really
    // gone — so the retry's ensure() either finds a fresh record or replaces
    // it under the spawner's one-process-per-user rule.
    registry.stop(userIdFor(user.email), "share respawn");
  }
}

// Zhiyu hatch export (add-zhiyu-room): pulls a transcript window out of the
// CALLER's own cell session — same ensure+impersonate shape as
// readSessionFromCell, but against the new /export route. Ownership proof is
// the cell's own gate: nothing this side sends can export a stranger's
// session, because the impersonated identity IS the caller's.
async function exportSessionFromCell(user, sessionId, window) {
  const cell = await registry.ensure(user);
  const r = await new Promise((resolve) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: cell.port,
        method: "GET",
        path: `/api/chat-history/sessions/${encodeURIComponent(sessionId)}/export?window=${encodeURIComponent(window)}`,
        headers: forwardedHeaders({ headers: {} }, user, SECRET),
        timeout: 15_000,
      },
      (up) => {
        let raw = "";
        up.setEncoding("utf8");
        up.on("data", (c) => (raw += c));
        up.on("end", () => {
          let body = null;
          try {
            body = JSON.parse(raw);
          } catch {
            /* non-JSON */
          }
          resolve({ status: up.statusCode, body });
        });
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("cell timeout")));
    upstream.on("error", (err) => resolve({ status: 0, error: err.message }));
    upstream.end();
  });
  if (r.status !== 200 || !r.body) {
    const err = new Error(r.body?.error || r.error || `cell answered ${r.status}`);
    err.status = r.status || 502;
    throw err;
  }
  return r.body;
}

// Create a share. The session must exist in the CALLER's own cell — the
// create-time fetch is the ownership proof (D3); the fetched title is stored
// denormalized for the revoke-list UI.
app.post("/api/share", express.json(), async (req, res) => {
  const user = resolveUser(req);
  if (!user) return rejectUnauthenticated(req, res);
  const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
  if (!sessionId || sessionId.length > 200) return res.status(400).json({ error: "sessionId required" });
  const fetched = await readSessionFromCell(user, sessionId);
  if (fetched.status === 404) return res.status(404).json({ error: "Session not found" });
  if (fetched.status !== 200) return res.status(502).json({ error: "Workspace unavailable" });
  const token = shareRegistry.create({
    email: user.email,
    groups: user.groups ?? [],
    sessionId,
    title: String(fetched.body?.title || ""),
  });
  res.json({ token, url: `/share/${token}` });
});

// The owner's active shares.
app.get("/api/share", (req, res) => {
  const user = resolveUser(req);
  if (!user) return rejectUnauthenticated(req, res);
  res.json({ shares: shareRegistry.listOwn(user.email) });
});

// Revoke: ownership-checked; false covers unknown/foreign/already-revoked.
app.delete("/api/share/:token", (req, res) => {
  const user = resolveUser(req);
  if (!user) return rejectUnauthenticated(req, res);
  if (!shareRegistry.revoke(user.email, req.params.token)) {
    return res.status(404).json({ error: "Share not found" });
  }
  res.json({ ok: true });
});

// The public read: the gateway's first content-bearing unauthenticated route.
// Rate-limited per source; registry lookup then owner-impersonated cell read.
app.get("/api/share/:token", async (req, res) => {
  if (!shareRateLimit(req)) return res.status(429).json({ error: "Too many requests" });
  const row = shareRegistry.live(req.params.token);
  if (!row) return res.status(404).json(SHARE_UNAVAILABLE);
  const groups = String(row.groups || "").split(",").filter(Boolean);
  const session = await readSessionFromCell({ email: row.email, groups }, row.session_id);
  if (session.status !== 200 || !session.body) return res.status(404).json(SHARE_UNAVAILABLE);
  res.json({ title: session.body.title ?? "", messages: session.body.messages ?? [] });
});

// ── Pack marketplace (openspec: add-pack-marketplace; add-facet-platform) ────
// With FACET_BASE_URL set the marketplace lives in the independently
// deployed facet service and this gateway proxies the whole /api/packs
// prefix onto it (gateway/facet-proxy.js) — same-origin for the browser, the
// verified identity rides along under the internal credential. Unset = the
// local mount (pre-facet posture; the rollback path — flip the env back).
const facetBase = (process.env.FACET_BASE_URL || "").replace(/\/+$/, "");
// Module scope: the shutdown handler closes it in pack mode; facet-proxy mode
// leaves it null (guarded call there). A block-scoped const here is what made
// SIGTERM throw ReferenceError in pack mode and skip cell shutdown entirely.
let packRegistry = null;
if (facetBase) {
  // FACET_PROXY_TIMEOUT_MS is opt-in: when unset (or non-positive / invalid)
  // we pass no timeoutMs and registerFacetProxy keeps its 30_000 default, so
  // behaviour stays byte-for-byte backward compatible. Only an explicitly
  // configured positive value widens the timeout — prod sets 120000 because a
  // pack deploy forwarding through this proxy can exceed 30s (deployToRegistry).
  const proxyTimeout = Number(process.env.FACET_PROXY_TIMEOUT_MS);
  // ── Credential-owner relay (fix-deploy-binding-mint-process) ─────────────
  // The market plane lives in facet and owns the deployment-secret store, but
  // the connector account a binding attenuates from lives in the USER'S CELL.
  // facet therefore asks here, and this gateway answers by calling that cell over
  // the same forged-identity channel it uses for every other cell request.
  //
  // Authenticated with FACET_INTERNAL_TOKEN only: this is a service-to-service
  // door, never a user door, and the value it returns is a freshly minted
  // binding token — it must not be reachable from the browser.
  {
    const facetToken = process.env.FACET_INTERNAL_TOKEN || "";
    const relayToCell = async (req, res, path) => {
      if (!facetToken || req.headers["x-facet-token"] !== facetToken) {
        return res.status(401).json({ ok: false, code: "unauthorized" });
      }
      const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
      if (!email) return res.status(400).json({ ok: false, code: "invalid_input", error: "email is required" });
      try {
        const cell = await registry.ensure({ email, groups: [] });
        if (!cell?.port) return res.status(503).json({ ok: false, code: "cell_unavailable" });
        const upstream = await fetch(`http://127.0.0.1:${cell.port}${path}`, {
          method: "POST",
          // Minimal identity headers, built rather than forwarded: copying the
          // caller's headers carries its content-length across, and the body is
          // RE-SERIALIZED here, so undici refuses with
          // UND_ERR_REQ_CONTENT_LENGTH_MISMATCH (measured 2026-11-08 — the relay
          // answered cell_unreachable for a cell that was answering fine).
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-email": email,
            "x-forwarded-groups": "",
            "x-cloud-gateway-secret": SECRET,
          },
          body: JSON.stringify(req.body ?? {}),
          signal: AbortSignal.timeout(20_000),
        });
        const parsed = await upstream.json().catch(() => null);
        return res.status(upstream.status).json(parsed ?? { ok: false, code: "upstream_body" });
      } catch (err) {
        const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
        return res.status(503).json({ ok: false, code: timeout ? "cell_timeout" : "cell_unreachable" });
      }
    };
    app.post("/api/gateway/binding-mint-batch", express.json({ limit: "16kb" }), (req, res) =>
      relayToCell(req, res, "/api/gateway/binding-mint-batch"),
    );
    app.post("/api/gateway/binding-mint", express.json({ limit: "16kb" }), (req, res) =>
      relayToCell(req, res, "/api/gateway/binding-mint"),
    );
    app.post("/api/gateway/binding-revoke", express.json({ limit: "16kb" }), (req, res) =>
      relayToCell(req, res, "/api/gateway/binding-revoke"),
    );
  }
  registerFacetProxy(app, {
    base: facetBase,
    resolveUser,
    token: process.env.FACET_INTERNAL_TOKEN || "",
    ...(proxyTimeout > 0 ? { timeoutMs: proxyTimeout } : {}),
  });
} else {
  // Gateway-level registry + routes: identity-gated creators publish
  // versioned, immutable capability packs; every authenticated user browses
  // and subscribes. The registry file sits beside share-tokens.db; packs
  // outlive and cross cells by the same argument. Publishing needs the
  // creator group (default "creators", same org→groups machinery as
  // ADMIN_GROUPS); browsing and subscribing need only a verified identity.
  // PACK_PUBLISH_RATE_MAX is a test/ops knob; the shipped default is 10
  // publishes per author per hour.
  packRegistry = createPackRegistry({ file: path.join(DATA_ROOT, "packs.db") });
  registerPackRoutes(app, {
    registry: packRegistry,
    resolveUser,
    rejectUnauthenticated,
    creatorGroups: (process.env.PACK_CREATOR_GROUPS || "creators")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    adminGroups: ADMIN_GROUPS,
    rateMax: Number(process.env.PACK_PUBLISH_RATE_MAX || 10),
    vendors: packRegistry.vendors,
    market: packRegistry.market,
    // Official showcase (add-official-pack-showcase): anonymous market read is
    // a deployment choice (default OFF — existing deployments see zero change);
    // the official roster is the ONLY official-badge source, author-declared
    // "official" anything is structurally ignored.
    anonymousRead: process.env.PACK_ANONYMOUS_READ === "1",
    officialAuthors: (process.env.OFFICIAL_AUTHOR_EMAILS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  });
  // Vendor supply-open (add-vendor-supply-open): identity + 供方上牌闸 ride
  // the same registry file and identity seam — the embedded (壹座 local-mount)
  // mount carries the same vendor lanes as the facet service.
  registerVendorRoutes(app, { vendors: packRegistry.vendors, resolveUser, rejectUnauthenticated, adminGroups: ADMIN_GROUPS });
  registerOnboardingRoutes(app, {
    vendors: packRegistry.vendors,
    onboarding: packRegistry.onboarding,
    resolveUser,
    rejectUnauthenticated,
    adminGroups: ADMIN_GROUPS,
  });
  // Market revenue share (add-market-revenue-share): 成交/结算/收益读面 ride
  // the same registry file — sub2api 客户端内置默认（SUB2API_* env）。
  registerMarketRoutes(app, {
    registry: packRegistry,
    vendors: packRegistry.vendors,
    market: packRegistry.market,
    resolveUser,
    rejectUnauthenticated,
    adminGroups: ADMIN_GROUPS,
  });
}

// ── Wanxing mount 摘挂（unify-wanxing-a2a-face 4.x）──────────────────────────
// The wanxing card/catalog/management face no longer mounts here: its single
// serving point is the independent facade (wanxing.finddatatech.cloud,
// FindDataTechnology/fd-wanxing). The zhiyu agent lane below reads deployment
// rows straight from the packs internal API (packs.js above), so nothing in
// this process imports gateway/wanxing anymore.

// ── Zhiyu room kernel (add-zhiyu-room) ──────────────────────────────────────
// 萬星·智语 phase 1: multi-human × multi-agent rooms. Lives at the gateway
// because rooms are cross-user objects (cells are per-user); owns the whole
// /api/zhiyu prefix before the cell-proxy catch-all. Agent seats dispatch
// onto the registry-proxy a2a lane, resolving deployments straight from the
// packs internal API (unify-wanxing-a2a-face 4.1 解耦：不再经 wanxing mount 的
// bookkeeping——該 mount 的卡片/目录/管理路由已摘挂至萬星 facade，见
// FindDataTechnology/fd-wanxing；本进程不再 import gateway/wanxing）。
const zhiyuLane = createZhiyuAgentLane({
  packsInternalBase: () =>
    (process.env.PACKS_INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.GATEWAY_PORT || 3080}`).replace(/\/+$/, ""),
  packsInternalToken: () => process.env.AGENT_SERVING_REGISTRY_TOKEN || process.env.MARKET_REGISTRY_TOKEN || "",
  registryUrl: () => (process.env.AGENT_SERVING_REGISTRY_URL || process.env.REGISTRY_URL || "").replace(/\/+$/, ""),
  registryToken: () => process.env.AGENT_SERVING_REGISTRY_TOKEN || process.env.MARKET_REGISTRY_TOKEN || "",
  backendToken: () => process.env.AGENT_SERVING_BACKEND_TOKEN || "",
});
const zhiyu = registerZhiyuRoutes(app, {
  dataRoot: DATA_ROOT,
  resolveUser,
  rejectUnauthenticated,
  env: process.env,
  secret: SECRET,
  webDist: WEB_DIST,
  callAgent: zhiyuLane.callAgent,
  settleTurn: zhiyuLane.settleTurn,
  cellExport: exportSessionFromCell,
  // Voice attribution (add-speaker-attribution 5.1, design D9): a capture
  // message carries its own stream evidence in `meta.capture`; every other
  // message answers null and keeps the legacy broadcast, so mounting this is a
  // no-op until the capture lane starts writing that field.
  voiceRoute: createVoiceRoute(),
  // The /api/zhiyu/* 404 guard is deferred: fleet-room-bridge below mounts
  // more routes under this prefix. zhiyu.registerNotFound() seals the prefix
  // once all of them are mounted (before the cell-proxy catch-all).
  deferNotFound: true,
});

// Fleet ↔ room bridge (add-zhiyu-team-memory 刀B): rooms subscribe to their
// principal's fleets; a pull tick samples the OWNER'S OWN cell overview over
// the forged-identity channel (no push into cells, no new uplink fields) and
// appends rate-merged system rows. Summon = batch-invite serving members
// through the store's existing invite handshake + the subscription.
{
  const bridgeTickMs = Number(process.env.FLEET_ROOM_BRIDGE_MS || 60_000);
  const bridge = registerFleetRoomBridge(app, {
    store: zhiyu.store,
    resolveUser,
    rejectUnauthenticated,
    sampleFleets: async (ownerEmail, path = "/api/fleets/overview") => {
      // The owner's OWN cell, over the same forged-identity channel the
      // projection lane uses (owner email + the shared secret). A dead or
      // erroring cell reports nothing — absence this tick, never an error.
      try {
        const cell = await registry.ensure({ email: ownerEmail, groups: [] });
        const res = await fetch(`http://127.0.0.1:${cell.port}${path}`, {
          headers: forwardedHeaders({ headers: {} }, { email: ownerEmail, groups: [] }, SECRET),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
    // Deployment ledger seam (fix-zhiyu-summon-serving-face 2.1): the summon
    // plan joins the cell's a2a posts (servingPath) against the packs internal
    // deployments — the same fetch the zhiyu agent-lane resolves seats with
    // (same env pair, same 8s discipline). null/throw = face unavailable;
    // the bridge degrades to an empty summonable honestly, never an error.
    servingDeployments: async () => {
      try {
        const base = (process.env.PACKS_INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.GATEWAY_PORT || 3080}`).replace(/\/+$/, "");
        const token = process.env.AGENT_SERVING_REGISTRY_TOKEN || process.env.MARKET_REGISTRY_TOKEN || "";
        if (!token) return null;
        const res = await fetch(`${base}/api/packs/internal/deployments`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        return (await res.json())?.deployments ?? null;
      } catch {
        return null;
      }
    },
  });
  // Self-scheduling loop (fix-zhiyu-room-lifecycle-and-bridge-watermark D3):
  // the tick awaits a cell sample (up to 15s), so a fixed 60s interval could
  // stack two rounds on the same stale baseline. Scheduling the next round
  // only after the previous one settles makes overlap structurally impossible
  // — tick() also keeps its own single-flight guard for manual invocations.
  let bridgeStopped = false;
  const bridgeLoop = async () => {
    if (bridgeStopped) return;
    try {
      await bridge.tick();
    } finally {
      if (!bridgeStopped) setTimeout(bridgeLoop, bridgeTickMs).unref?.();
    }
  };
  const bridgeTimer = setTimeout(bridgeLoop, bridgeTickMs);
  bridgeTimer.unref?.();
}

// Seal the /api/zhiyu/* prefix now that the room kernel, IM bridge and fleet
// bridge are all mounted. This MUST stay after registerFleetRoomBridge and
// before the cell-proxy catch-all: an early 404 guard swallows the fleet
// bridge's subscriptions/summon endpoints (fix-zhiyu-fleet-bridge-route-order).
zhiyu.registerNotFound();

// ── Bot webhooks: machine callers with no platform identity ────────────────
// Chat-platform servers (WeChat OA / WeCom / Feishu / Telegram) sign their own
// requests and cannot hold a Logto session; the catch-all below would 401 them
// before any cell sees the traffic. The webhook's auth domain is the per-bot
// path secret plus the adapter's signature check INSIDE the cell (the route is
// identity-exempt there by design) — the gateway's only job is routing the
// request to the owning cell, booting it if the bot's owner is idle.
const botWebhookRouter = createBotWebhookRouter({
  dataRoot: DATA_ROOT,
  openDb: (p) => new Database(p, { readonly: true }),
});
app.all("/api/bots/webhook/:botId/:secret", async (req, res) => {
  const target = botWebhookRouter.resolve(req.params.botId);
  if (!target.email) {
    // Logged: a bot the gateway cannot attribute may be a typo'd path in the
    // platform's console — a silent 404 is indistinguishable from "the
    // platform never called" (fd-prod lesson, add-user-questions).
    console.warn(`[gateway] webhook for unknown bot ${req.params.botId} from ${req.ip}`);
    return res.sendStatus(404);
  }
  try {
    // groups stay empty: the cell's demo flag and bindings were pinned at its
    // first authenticated spawn; this only re-targets an existing owner.
    const cell = await registry.ensure({ email: target.email, groups: [] });
    proxyHttp(req, res, {
      host: "127.0.0.1",
      port: cell.port,
      // The caller's own headers pass through (minus hop-by-hop and identity):
      // content-type/content-length are load-bearing for the cell's body
      // parsers. No identity headers — the webhook path is exempt in the cell;
      // the gateway secret still attributes origin.
      headers: machineHeaders(req, SECRET),
    });
  } catch (err) {
    console.error(`[gateway] webhook cell start failed for ${target.email}: ${err.message}`);
    res.status(503).json({ error: "Your workspace failed to start" });
  }
});

// ── Bot relay: machine callers reach the bots owner's cell ──────────────────
// The relay route authenticates by deployment token INSIDE the cell (bot-relay
// spec: exempt from interactive identity), but the catch-all below would 401 a
// token-bearing caller before any cell sees it — machine callers (the
// agent-runner's notifier) hold no Logto session. Route the prefix to the
// configured bots-owner cell with machine headers, exactly like the webhook
// path. Without an owner configured the prefix answers 404 — the relay's own
// inert semantics, preserved at the gateway layer (add-agent-notifications 3.1
// 前置: cells 拓扑下 runner→relay 的可达性).
// Cell dirs under DATA_ROOT (CELL_DATA_ROOT already ends in /cells) — hex id
// dirs only; anything else (dotfiles, staging) is not a cell.
function listCellDirs() {
  try {
    return readdirSync(DATA_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[0-9a-f]{16}$/.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// ── Ops reads (add-pack-usage-telemetry): the aggregate lives at the plane ──
// The usage ledger is per-cell SQLite under DATA_ROOT, and the gateway is the
// only process that sees every cell — so the aggregate reads HERE (read-only
// opens of each cell's app.db, own bearer credential). In the per-user-cell
// topology a user exists in exactly one cell, so summing per-cell DISTINCT
// users is exact, not an approximation. The cell-level twin route
// (server/routes/pack-usage.js) serves single-cell dev/e2e shapes.
app.get("/api/ops/pack-usage", async (req, res) => {
  const token = process.env.PACK_USAGE_TOKEN?.trim();
  if (!token) return res.status(503).json({ error: "pack usage surface not configured on this deployment" });
  if (req.headers.authorization !== `Bearer ${token}`) return res.status(401).json({ error: "ops credential required" });
  const windowDays = Math.min(Math.max(Number(req.query.days) || 7, 1), 365);
  const since = Date.now() - windowDays * 86_400_000;
  const merged = new Map(); // packId(null=packless) → {turns, activeUsers, lastUsedAt}
  let cellsSeen = 0;
  for (const dir of listCellDirs()) {
    const file = path.join(DATA_ROOT, dir, "data", "data", "app.db");
    let db = null;
    try {
      db = new Database(file, { readonly: true });
      const rows = db.prepare(
        `SELECT pack_id AS packId, COUNT(*) AS turns, COUNT(DISTINCT user_email) AS activeUsers, MAX(ts) AS lastUsedAt
         FROM pack_usage_events WHERE ts >= ? GROUP BY pack_id`,
      ).all(since);
      for (const r of rows) {
        const key = r.packId ?? "";
        const cur = merged.get(key) ?? { packId: r.packId, turns: 0, activeUsers: 0, lastUsedAt: 0 };
        cur.turns += r.turns;
        cur.activeUsers += r.activeUsers;
        cur.lastUsedAt = Math.max(cur.lastUsedAt, r.lastUsedAt ?? 0);
        merged.set(key, cur);
      }
      cellsSeen += 1;
    } catch {
      // A cell without the table yet (pre-telemetry image) or a locked db
      // contributes nothing — the aggregate is best-effort per cell.
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
  }
  const rows = [...merged.values()].sort((a, b) => b.turns - a.turns);
  res.json({
    windowDays,
    cells: cellsSeen,
    weeklyActivePacks: rows.filter((r) => r.packId && r.activeUsers >= 1).length,
    rows,
  });
});

// ── Trial-exec service channel (add-supply-studio-migration 5.3) ────────────
// The supply domain's Studio calls the run domain headlessly over the shared
// internal credential (x-facet-token, timing-safe inside the route). Machine
// callers hold no Logto session, so the identity catch-all below would 401
// them before any route sees the request — route the prefix to the platform
// owner's cell with machine headers, exactly like the bot relay above (the
// gateway is the routing terminator: the cell-side route re-verifies the
// credential itself; the gateway secret only attributes origin). Without an
// owner configured the prefix answers 404 — the channel's inert semantics.
// NOTE: no gateway-side body parser — the raw stream must reach the cell
// intact (proxyHttp pipes req; a gateway-side express.json consumes the body
// and the cell's parser waits forever — found live, first probe).
app.all("/api/trial-exec", async (req, res) => {
  const ownerEmail = process.env.BOTS_RELAY_OWNER_EMAIL || "";
  if (!ownerEmail) return res.status(404).json({ error: "trial-exec not configured" });
  try {
    // groups stay empty: this only re-targets an existing owner (relay rule).
    const cell = await registry.ensure({ email: ownerEmail, groups: [] });
    proxyHttp(req, res, {
      host: "127.0.0.1",
      port: cell.port,
      headers: machineHeaders(req, SECRET),
    });
  } catch (err) {
    console.error(`[gateway] trial-exec cell start failed for ${ownerEmail}: ${err.message}`);
    res.status(503).json({ error: "trial-exec owner workspace failed to start" });
  }
});

app.all(/^\/api\/bots\/relay\//, async (req, res) => {
  const ownerEmail = process.env.BOTS_RELAY_OWNER_EMAIL || "";
  if (!ownerEmail) return res.status(404).json({ error: "relay not configured" });
  try {
    // groups stay empty: this only re-targets an existing owner (webhook rule).
    const cell = await registry.ensure({ email: ownerEmail, groups: [] });
    proxyHttp(req, res, {
      host: "127.0.0.1",
      port: cell.port,
      headers: machineHeaders(req, SECRET),
    });
  } catch (err) {
    console.error(`[gateway] relay cell start failed for ${ownerEmail}: ${err.message}`);
    res.status(503).json({ error: "relay owner workspace failed to start" });
  }
});

// Everything else belongs to a cell.
// One cell dispatch shared by the Logto path and the desk-embed host path
// (add-crm-desk-pack-embed D6): ensure the user's cell, then proxy with the
// verified identity injected.
async function dispatchToCell(req, res, user) {
  // The roster is what the admin surface lists (cells are keyed by hash, so
  // this write is where a real email enters the store).
  roleStore.noteUser(user.email);
  let cell;
  try {
    cell = await registry.ensure(user);
  } catch (err) {
    // Demo capacity is a normal, expected condition (openspec: mp-demo-mode):
    // the reply stays friendly and machine-readable instead of a raw spawn
    // failure.
    if (err.code === "demo_capacity") {
      return res.status(503).json({ error: err.friendly, code: "demo_capacity" });
    }
    console.error(`[gateway] cell start failed for ${userIdFor(user.email)}: ${err.message}`);
    return res.status(503).json({ error: `Your workspace failed to start: ${err.message}` });
  }
  proxyHttp(req, res, {
    host: "127.0.0.1",
    port: cell.port,
    headers: forwardedHeaders(req, user, SECRET, {
      roleHeaders: roleStore.headersFor(user.email),
      layoutHeader: layoutStore.headerValue(),
    }),
  });
}

// Desk embed host (add-crm-desk-pack-embed D6): the edge serves a dedicated
// sibling host (DESK_EMBED_HOST) so the proxied Chatwoot SPA is same-origin —
// its session cookie is JS-written on its own origin and cannot be injected
// cross-origin. The Logto session cookie does not ride a sibling host either,
// so identity here = the short-lived HMAC embed token the user's cell minted
// when they clicked the desk entry (query `et` on entry, then the embed cookie
// the cell set on this host). Everything else on this host is rejected.
const DESK_EMBED_HOST = process.env.DESK_EMBED_HOST || "";
if (DESK_EMBED_HOST) {
  const embedEmail = (req) => {
    if ((req.headers.host || "").split(":")[0] !== DESK_EMBED_HOST) return null;
    const cookies = req.headers.cookie || "";
    const m = /(?:^|;\s*)desk_embed=([^;]+)/.exec(cookies);
    const { verifyEmbedToken } = sessionHelpers;
    if (m) {
      const hit = verifyEmbedToken(decodeURIComponent(m[1]), SECRET);
      if (hit) return hit;
    }
    const et = new URL(req.url, "http://x").searchParams.get("et");
    return et ? verifyEmbedToken(et, SECRET) : null;
  };
  app.use((req, res, next) => {
    if ((req.headers.host || "").split(":")[0] !== DESK_EMBED_HOST) return next();
    const hit = embedEmail(req);
    if (!hit) return res.status(401).send("嵌入会话无效或已过期，请从壹座重新进入客服台");
    dispatchToCell(req, res, { email: hit.email, groups: [] }).catch((err) => {
      console.error(`[gateway] desk-embed dispatch failed: ${err.message}`);
      if (!res.headersSent) res.status(502).send("客服台嵌入暂时不可用");
    });
  });
}

// 主人经营的跨机占位 (fleet-owner-surface)：坞面渲染的「机位行」读面 —
// cells-registry 的 durable 行 × 在线判定, 必须在 cell-proxy catch-all 之前
// 落, 否则请求会被转给单台 cell、永远看不到机位全局视角。
registerOwnerCellsRoute(app, { registryDb: cellRegistryDb, resolveUser, rejectUnauthenticated });

// 内存分布读面 (harden-platform-memory-carrier 1.2)：容器三层分布（cgroup
// 水位 → per-cell 进程归组 → 进程行）+ 准入阈值透出。sampler 与驻留闸共享
// 一份 TTL 缓存，读面与闸读同一份采样，数字永不打架。
registerMemoryFaceRoute(app, {
  sampler: procMemorySampler,
  registryDb: cellRegistryDb,
  resolveUser,
  rejectUnauthenticated,
  isAdminUser,
  threshold: CELL_MEMORY_FLOOR,
  browserLaneProbe,
});

// ── Disclosure-gate machine door (fix-disclosure-gate-reachability) ─────────
// The verdict endpoint is machine-to-machine: a runner asks a cell "may this
// outbound text be sent". It holds no user identity, and the cell-proxy
// catch-all below refuses anything without one — so the cell-side
// AUTH_EXEMPT_PREFIXES never runs. Measured 2026-11-11 with the token correctly
// injected on both sides: `401 Authentication required`, forever.
//
// Three things make this door safe, and all three are load-bearing:
//   * it is registered BEFORE the catch-all (precedent: bot webhooks). After it,
//     the door is dead code and the 401 comes back.
//   * the bearer is checked FIRST; the owner header is read only once it passes,
//     so an unauthenticated caller cannot name a cell at all.
//   * the target must be a RUNNING cell. No fallback to any default cell: a
//     fallback would answer A's text with B's policy, which is the one failure
//     this endpoint exists to prevent.
// No body parser here on purpose — the request is piped through unchanged, so
// the cell's own handler parses (and validates) the payload exactly once.
// The decision itself lives in gateway/mandate-door.js (pure, contract-tested).
const MANDATE_VERDICT_TOKEN = String(process.env.MANDATE_VERDICT_TOKEN || "");

app.post(MANDATE_VERDICT_PATH, (req, res) => {
  const verdict = decideMandateDoor({
    configuredToken: MANDATE_VERDICT_TOKEN,
    authorization: req.headers.authorization,
    ownerHeader: req.headers[MANDATE_OWNER_HEADER],
    runningCells: registry.status(),
  });
  if (verdict.status !== 200) return res.status(verdict.status).json({ error: verdict.error });
  proxyHttp(req, res, {
    host: "127.0.0.1",
    port: verdict.cell.port,
    headers: forwardedHeaders(req, { email: verdict.owner, groups: [] }, SECRET, {
      roleHeaders: roleStore.headersFor(verdict.owner),
      layoutHeader: layoutStore.headerValue(),
    }),
  });
});

// ── Input-request machine door (add-acp-input-request-owner) ────────────────
//
// The ACP lane reaches request_input over streamable HTTP with a shared bearer.
// Same wall, same answer as the disclosure gate above: without a door here, a
// correct bearer answers `401 Authentication required` and the cell never sees
// it (measured 2026-11-12 on sha-f34ed77). Same three rules, same reasons:
// bearer first, owner only names a RUNNING cell, and never a default cell —
// a fallback would land one owner's card inside another owner's session.
//
// No body parser: proxyHttp streams the request through, so the cell's own
// handler parses once AND the SSE response streams back untouched (an MCP
// streamable-HTTP reply is `text/event-stream`; buffering it would hang the
// runner's long poll).
// The decision lives in gateway/input-request-door.js (pure, contract-tested).
const INPUT_REQUEST_MCP_TOKEN = String(process.env.INPUT_REQUEST_MCP_TOKEN || "");

app.post(INPUT_REQUEST_MCP_PATH, (req, res) => {
  const verdict = decideInputRequestDoor({
    configuredToken: INPUT_REQUEST_MCP_TOKEN,
    authorization: req.headers.authorization,
    ownerHeader: req.headers[INPUT_REQUEST_OWNER_HEADER],
    runningCells: registry.status(),
  });
  if (verdict.status !== 200) {
    // Codes and bodies mirror server/input-request-http.js so a caller cannot
    // tell which side refused — one contract, two mounts.
    return res.status(verdict.status).json({ error: verdict.error });
  }
  proxyHttp(req, res, {
    host: "127.0.0.1",
    port: verdict.cell.port,
    headers: forwardedHeaders(req, { email: verdict.owner, groups: [] }, SECRET, {
      roleHeaders: roleStore.headersFor(verdict.owner),
      layoutHeader: layoutStore.headerValue(),
    }),
  });
});

// ── 门 K 换票（converge-line-identity-and-keys 7.1）─────────────────────────
// 客户拿词元 sk- 换一枚 aud=目标线、带 source、≤10 分钟的 JWT；线侧只做离线
// JWKS 验签。**这个接缝必须在 cell-proxy 兜底之前**（同 mandate/input-request
// 两道机器门的先例）：兜底要求用户身份，而换票的调用方恰恰没有会话。
//
// 开关关闭时 `registerLineExchange()` 挂 0 条路由——不是返回 404，是路径不存在。
// 这是验收原文「开关关闭时网关行为与现状一致」唯一可靠的实现方式：现行网关按设计
// 剥掉调用方 Authorization，改成发币是行为变更，必须显式开。
//
// 钥匙校验复用 lib/sub2api-admin.js 那份客户端（与萬星 A2A 同一套
// findUserByKey + probeKeyLiveness）：同一份凭据两个读者必须共用解析。
const lineExchangeSub2api = createSub2apiClient();
registerLineExchange(app, {
  verifyCaller: async (key) => {
    // 计费面没配 admin key = 没人能回答"这把钥匙是谁"。返回 503 让线走自有轨，
    // 不能回 401——那会让客户以为钥匙坏了去重贴。
    if (lineExchangeSub2api.degraded()) return { ok: false, status: 503 };
    const probe = await lineExchangeSub2api.probeKeyLiveness(key);
    if (!probe.ok) {
      // 探活打不通（status 0）= 上游不可达，仍是 503；2xx 之外的上游判定
      // （INVALID_KEY / INSUFFICIENT_BALANCE / …）是 401，交给调用方对号。
      return { ok: false, reason: "invalid_credential", status: probe.status === 0 ? 503 : 401 };
    }
    const holder = await lineExchangeSub2api.findUserByKey(key);
    if (!holder) return { ok: false, reason: "unresolved_credential" };
    return { ok: true, userId: holder.userId, email: holder.email ?? null };
  },
});

app.use(async (req, res) => {
  const user = resolveUser(req);
  if (!user) return rejectUnauthenticated(req, res);
  dispatchToCell(req, res, user);
});

// WebSocket upgrades take the same identity check, then pin to the user's cell
// for the life of the socket.
server.on("upgrade", async (req, socket, head) => {
  const user = resolveUser(req);
  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  let cell;
  try {
    cell = await registry.ensure(user);
  } catch (err) {
    if (err.code === "demo_capacity") {
      const body = JSON.stringify({ error: err.friendly, code: "demo_capacity" });
      socket.write(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${body}`);
      socket.destroy();
      return;
    }
    console.error(`[gateway] WS cell start failed for ${userIdFor(user.email)}: ${err.message}`);
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  proxyUpgrade(req, socket, head, {
    host: "127.0.0.1",
    port: cell.port,
    headers: forwardedHeaders(req, user, SECRET, {
      keepUpgrade: true,
      roleHeaders: roleStore.headersFor(user.email),
      layoutHeader: layoutStore.headerValue(),
    }),
  });
  // Book the socket against the cell BEFORE any await can lose it, and release
  // it exactly once. `close` and `error` can both fire; the `done` latch keeps
  // the count from going negative and skewing the reaper's liveness view.
  const cellId = cell.userId;
  liveSockets.set(cellId, (liveSockets.get(cellId) ?? 0) + 1);
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    const next = (liveSockets.get(cellId) ?? 1) - 1;
    if (next > 0) liveSockets.set(cellId, next);
    else liveSockets.delete(cellId);
  };
  socket.once("close", release);
  socket.once("error", release);
});

// Test seam (harden-cell-execution-reliability 3.2): GATEWAY_ASSEMBLY_ONLY=1
// assembles the full route surface but skips server.listen, so the assembly
// smoke test can import this module and read the route registry without
// binding a port. Unset — the production default (`node gateway/index.js`) —
// runtime behavior is unchanged.
if (process.env.GATEWAY_ASSEMBLY_ONLY !== "1") {
  server.listen(PORT, HOST, () => {
    console.log(`[gateway] listening on http://${HOST}:${PORT} (cells under ${DATA_ROOT})`);
    console.log(`[gateway] idle reaping: ${IDLE_REAP_SECS > 0 ? `after ${IDLE_REAP_SECS}s` : "disabled (cells stay resident)"}`);
  });
}

// Named export for scripts/test-gateway-assembly.mjs: the assembled Express
// app, so the smoke test asserts the live route registry instead of parsing
// source. No runtime effect — the gateway itself runs as a script.
export const gatewayAppForTests = app;

// No cell outlives the gateway: a redeploy would otherwise leak one process
// per user on the host. Auxiliary closes are failure-isolated on purpose: a
// throw anywhere in this chain skips everything after it (the pack-mode
// ReferenceError did exactly that — cells then died with the pod instead of
// gracefully), and cell shutdown must not depend on any of them.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    console.log(`[gateway] ${signal} — stopping ${registry.cells.size} cell(s)`);
    try { shareRegistry.close(); } catch (e) { console.error(`[gateway] share registry close failed: ${e.message}`); }
    try { if (packRegistry) packRegistry.close(); } catch (e) { console.error(`[gateway] pack registry close failed: ${e.message}`); }
    try { zhiyu.close(); } catch (e) { console.error(`[gateway] zhiyu close failed: ${e.message}`); }
    try { cellFleetReporter?.stop(); } catch { /* telemetry timer; unref'd anyway */ }
    try { dutyRing?.stop(); } catch { /* ring timer; unref'd anyway */ }
    await registry.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
