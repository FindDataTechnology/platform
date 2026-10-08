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
import { fileURLToPath } from "node:url";
import { createLogtoAuth } from "../server/logto-auth.js";
import { resolveSessionSecret } from "../server/session.js";
import { createCellRegistry, userIdFor } from "./spawner.js";
import { forwardedHeaders, machineHeaders, proxyHttp, proxyUpgrade } from "./proxy.js";
import { createMpAuth } from "./mp-auth.js";
import { createMpBindings } from "./mp-bindings.js";
import { createShareRegistry, createRateLimiter } from "./share.js";
import { createPackRegistry, registerPackRoutes } from "./packs.js";
import { registerFacetProxy } from "./facet-proxy.js";
import { registerWanxingRoutes } from "./wanxing/index.js";
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

const registry = createCellRegistry({
  dataRoot: DATA_ROOT,
  secret: SECRET,
  startTimeoutMs: START_TIMEOUT_MS,
  idleReapSecs: IDLE_REAP_SECS,
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
});

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
    const payload = mpAuth.verifyToken(auth.slice(7));
    if (payload) return { email: payload.email, groups: payload.groups ?? [], mp: true };
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

// ── Pre-login SPA shell (add-login-hero 6.2) ───────────────────────────────
// Registered just before the identity catch-all (below), after every concrete
// route — /healthz and the /api/* routes must not be swallowed by the SPA
// fallback. The React app decides for itself whether to show the login page
// (it reads /api/auth/me and /api/config, both reachable anonymously) — but
// only if it can load. Without these routes the catch-all redirects every
// request, including the bundle itself, straight to the hosted Logto page, so
// the product's own login surface is unreachable on a hosted deployment.
const WEB_DIST = path.join(REPO, "web", "dist");
app.use(express.static(WEB_DIST));
app.get(/^\/(?!api\/|external\/|auth\/|healthz$|assets\/).*/, (_req, res) => {
  res.sendFile(path.join(WEB_DIST, "index.html"));
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
  res.type("html").send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>绑定小程序</title>
<body style="font-family:system-ui;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#f3f4f6">
  <div style="text-align:center;background:#fff;padding:48px 64px;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,.08)">
    <div style="color:#6b7280;font-size:14px">微信小程序 · 登录绑定码（${user.email}）</div>
    <div style="font-size:56px;letter-spacing:12px;font-weight:700;color:#111827;margin:24px 0">${code}</div>
    <div style="color:#9ca3af;font-size:13px">5 分钟内有效，一次性使用。在小程序登录页输入此码完成绑定。</div>
    <div style="margin-top:20px"><a href="/api/mp/bindcode" style="color:#2563eb;font-size:14px">刷新新码</a></div>
  </div>
</body>`);
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

// Liveness. Public by design — a probe has no session cookie — and it reports
// no per-user information.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, uptimeMs: Date.now() - startedAt, cells: registry.cells.size });
});

// The admin group name(s) — see registerAuth's ADMIN_GROUPS for the rationale
// (per-product Logto org-role names). The gateway runs its own process, so it
// reads the same env directly.
const ADMIN_GROUPS = (process.env.ADMIN_GROUPS || "admin")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const isAdminUser = (user) => ADMIN_GROUPS.some((g) => (user.groups || []).includes(g));

// Per-user cell status for operators. Same identity check as everything else,
// plus the admin group: the list of users on this deployment is deployment
// information, not something any signed-in user should be able to enumerate.
app.get("/api/gateway/status", (req, res) => {
  const user = logtoAuth.userFromCookie(req.headers.cookie);
  if (!user) return rejectUnauthenticated(req, res);
  if (!isAdminUser(user)) return res.status(403).json({ error: "Admin group required" });
  const cellStatus = registry.status();
  res.json({
    cells: cellStatus,
    demoCells: cellStatus.filter((c) => c.demo).length,
    idleReapSecs: IDLE_REAP_SECS,
    dataRoot: DATA_ROOT,
    uptimeMs: Date.now() - startedAt,
  });
});

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
    registry.drop(userIdFor(user.email));
  }
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
  registerFacetProxy(app, {
    base: facetBase,
    resolveUser,
    token: process.env.FACET_INTERNAL_TOKEN || "",
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
  });
}

// ── Wanxing facade (openspec: add-wanxing-serving-api; ADR-0014) ────────────
// The external front door: callers authenticate with their own sub2api key,
// agents are admitted by visibility/allowlist, turns are metered and settled
// at the boundary. Registered before the cell-proxy catch-all so these
// routes never fall into Logto identity; its own SQLite file sits beside
// packs.db (ledger + allowlist + idempotency). Deployment bookkeeping is
// read over the packs internal API (add-facet-platform S0) — loopback to
// this process by default, PACKS_INTERNAL_BASE_URL repoints it.
registerWanxingRoutes(app, {
  dataRoot: DATA_ROOT,
  resolveUser,
  rejectUnauthenticated,
  creatorGroups: (process.env.PACK_CREATOR_GROUPS || "creators")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  adminGroups: ADMIN_GROUPS,
  env: process.env,
});

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
app.use(async (req, res) => {
  const user = resolveUser(req);
  if (!user) return rejectUnauthenticated(req, res);
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
    headers: forwardedHeaders(req, user, SECRET),
  });
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
    headers: forwardedHeaders(req, user, SECRET, { keepUpgrade: true }),
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[gateway] listening on http://${HOST}:${PORT} (cells under ${DATA_ROOT})`);
  console.log(`[gateway] idle reaping: ${IDLE_REAP_SECS > 0 ? `after ${IDLE_REAP_SECS}s` : "disabled (cells stay resident)"}`);
});

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
    await registry.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
