// Optional forward-auth (AUTH_MODE=forward_auth). Identity = proxy-injected
// X-Forwarded-Email / X-Forwarded-Groups headers (Caddy forward_auth →
// oauth2-proxy → Logto). TRUST BOUNDARY: enabling this asserts the server is
// reachable ONLY through the forward-auth proxy — bind to localhost /
// firewall it, otherwise these headers are attacker-controlled.
//
// Hosted cells (CLOUD_MODE) cannot rely on that reachability assumption: the
// gateway and the cells share a host, so anything that can reach the cell's
// loopback port could forge the headers. There the trust is enforced actively
// with a shared secret the gateway injects; see `userFromHeaders`'s `trust`.

import { timingSafeEqual } from "node:crypto";
import { noteOwnerGroups } from "./owner-groups.js";

// Paths exempt from the identity requirement, because the caller is an
// external service that cannot supply the proxy header. Each exempt path MUST
// carry its own authentication — this list is not a public-route escape hatch.
//   /api/bots/webhook/ — chat platforms (WeCom/Feishu/Telegram/WeChat OA);
//     authenticated by the per-bot path secret plus the platform's own
//     signature check or payload decryption (see server/routes/bots.js).
//   /api/bots/relay/ — machine callers on an operator-trusted network (cloud
//     MCP services); authenticated by a deployment-injected bearer token
//     compared in constant time, checked before the body is read (see
//     server/routes/bot-relay.js). Inert (404) with no token configured.
//   /api/mp/login, /api/mp/login-bindcode — the WeChat mini program, which
//     has no browser session to authenticate with; each call authenticates
//     through its own wx.login code2Session exchange (plus the bind code on
//     the -bindcode path). Inert (503 not-configured) without MP credentials.
const AUTH_EXEMPT_PREFIXES = [
  "/api/bots/webhook/",
  "/api/bots/relay/",
  "/api/mp/login",
  "/api/mp/login-bindcode",
];

export function normalizeAuthPath(value, fallback) {
  const raw = String(value || "").trim();
  return raw.startsWith("/") && !raw.startsWith("//") && !/\s/.test(raw) ? raw : fallback;
}

const isPublicRequest = (req) => {
  if (!["GET", "HEAD"].includes(req.method)) return false;
  const p = req.path;
  return (
    p === "/api/auth/me" ||
    p === "/login" ||
    p.startsWith("/assets/") ||
    // Pack skill raw-md (add-a2a-agent-serving): the registry fetches
    // skill_md_url ANONYMOUSLY at deploy validation — the gateway's public
    // md route must pass without a session (market bodies, machine-shaped).
    (p.startsWith("/api/packs/") && p.endsWith(".md")) ||
    (!p.startsWith("/api/") && !p.startsWith("/external/"))
  );
};

const isLogtoPublicRequest = (req) => {
  const p = req.path;
  if (p === "/api/auth/logout") return true;
  if (!["GET", "HEAD"].includes(req.method)) return false;
  // Pack skill raw-md (add-a2a-agent-serving): the registry fetches
  // skill_md_url ANONYMOUSLY when validating a deploy, so the gateway's
  // public md route must be reachable without a session — market skill
  // bodies are public content, machine-shaped.
  if (p.startsWith("/api/packs/") && p.endsWith(".md")) return true;
  return p === "/api/auth/me" || p === "/api/config" || p === "/api/ready" || p === "/login" || p === "/auth/login" || p === "/auth/callback" || p.startsWith("/assets/");
};

const isExempt = (p) => AUTH_EXEMPT_PREFIXES.some((prefix) => p.startsWith(prefix));

// Loopback caller check for the in-cell internal bridge. The cron MCP child
// (stdio, spawned by the dsh runtime inside this cell) drives the engine over
// /api/cron; it has no session cookie and no gateway secret, so loopback is
// its credential. Any non-loopback caller still faces the full auth gate —
// the exemption never widens beyond the cell's own node.
const isLoopback = (addr) =>
  addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
const isInternalCronBridge = (req) =>
  (req.path === "/api/cron" || req.path.startsWith("/api/cron/")) &&
  isLoopback(req.socket?.remoteAddress);

// The chart-bind bridge (`chart_bind`, openspec: add-chart-data-binding) is the
// same shape: a dsh-plugin tool in the cell's own child declaring the data call
// behind the chart this turn produced. Loopback is its credential, and the
// route it reaches only ever acts on the platform's CURRENT turn — it cannot
// name another session's chart, and a non-loopback caller still faces the gate.
const isInternalChartBridge = (req) =>
  req.path === "/api/resources/bind-declared" && isLoopback(req.socket?.remoteAddress);

// The delegation bridge (openspec: add-agent-delegation-tools) — same
// credential model as the cron bridge: the in-cell delegation MCP child drives
// the task engine's manual path over /api/delegation. Loopback only; everyone
// else still faces the full gate.
const isInternalDelegationBridge = (req) =>
  req.path.startsWith("/api/delegation/") && isLoopback(req.socket?.remoteAddress);

// The header the gateway injects alongside the identity headers in hosted mode.
export const GATEWAY_SECRET_HEADER = "x-cloud-gateway-secret";

// Constant-time secret compare. Exported for the exempt routes that carry their
// own authentication (the bot relay's bearer token) — one implementation, so a
// caller-supplied secret is never compared with `===`.
export function secretMatches(provided, expected) {
  if (typeof provided !== "string" || !expected) return false;
  const given = Buffer.from(provided);
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

// `trust` is ctx.headerTrust: null outside hosted mode, `{ secret }` inside it.
// When set, identity headers count only if the request also carries the gateway
// secret — an unauthorised caller's headers are treated as absent entirely, so
// the request proceeds as unauthenticated rather than as the spoofed identity.
// Normalize an optional-SSO identity's email (trim + lowercase). The overlay
// keys personal bindings by the normalized address — cross-case headers must
// resolve to one row. Forward-auth identities (req.user, cell routing) are
// deliberately NOT normalized: the gateway's canonical spelling is the
// deployment's identity contract.
export function normalizeSsoEmail(user) {
  if (!user?.email) return user;
  return { ...user, email: String(user.email).trim().toLowerCase() };
}

export function userFromHeaders(headers, trust) {
  if (trust && !secretMatches(headers[GATEWAY_SECRET_HEADER], trust.secret)) return null;
  const email = String(headers["x-forwarded-email"] || "").trim();
  if (!email) return null;
  const groups = String(headers["x-forwarded-groups"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { email, groups };
}

// Mini-program platform token (openspec: miniprogram-auth) — the gateway's
// `resolveUser` Bearer branch, same shape. Returns the token-derived identity
// or null; `mp: true` marks the door (the cell sees the email/groups either
// way). Inert without MP credentials (verifyToken returns null). Shared with
// the WebSocket upgrade gate (server/ws.js).
export function mpUserFromToken(ctx, req) {
  const auth = req.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
  const payload = ctx.mpAuth?.verifyToken(auth.slice(7));
  if (!payload) return null;
  return { email: payload.email, groups: payload.groups ?? [], mp: true };
}

// Install the HTTP auth gate. forward_auth trusts proxy-injected identity;
// logto verifies the signed session cookie and ignores those headers.
export function registerAuth(ctx) {  ctx.app.use((req, res, next) => {
    if (isInternalCronBridge(req)) {
      req.user = { email: "cron@internal", internal: true };
      return next();
    }
    if (isInternalChartBridge(req)) {
      req.user = { email: "chart-bridge@internal", internal: true };
      return next();
    }
    if (isInternalDelegationBridge(req)) {
      req.user = { email: "delegation@internal", internal: true };
      return next();
    }
    const headerUser = userFromHeaders(req.headers, ctx.headerTrust);
    if (ctx.authMode === "logto") {
      // A verified MP Bearer token is a second door into the same identity:
      // cookie first (parity with the gateway's resolveUser), token fallback.
      if (isLogtoPublicRequest(req) || isExempt(req.path)) {
        const user = ctx.logtoAuth?.authenticate(req, res) || mpUserFromToken(ctx, req);
        if (user) req.user = user;
        return next();
      }
      const user = ctx.logtoAuth?.authenticate(req, res) || mpUserFromToken(ctx, req);
      if (!user) {
        if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Authentication required" });
        if (req.accepts("html")) return res.redirect("/login");
        return res.status(401).json({ error: "Authentication required" });
      }
      req.user = user;
      return next();
    }

    if (ctx.authEnabled) {
      if (isPublicRequest(req) || isExempt(req.path)) {
        if (headerUser) req.user = headerUser;
        return next();
      }
      if (!headerUser) return res.status(401).json({ error: "Authentication required" });
      req.user = headerUser;
      return next();
    }
    // Optional SSO is an identity overlay only. It never turns auth off into
    // forward-auth, grants admin rights, or changes route authorization.
    // The overlay's email is normalized (trim + lowercase) at the trust
    // boundary: personal bindings are keyed "by normalized SSO email" (the
    // feature contract), so Alice@Corp.COM and alice@corp.com share one row.
    if (ctx.ssoEnabled && headerUser) req.ssoUser = normalizeSsoEmail(headerUser);
    next();
  });

  // Gate for mutating admin routes (LLM provider CRUD, catalog refresh).
  // Open to any client when auth is off.
  // The admin group name(s). Logto deployments name their org role per-product
  // (e.g. platform-admin) to avoid clashing with other services' roles on the
  // same tenant; forward-auth proxies pass whatever group names they like.
  // ADMIN_GROUPS is a comma-separated list; unset = the historical "admin".
  ctx.adminGroups = (process.env.ADMIN_GROUPS || "admin")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  ctx.isAdminUser = (user) =>
    Array.isArray(user?.groups) && ctx.adminGroups.some((g) => user.groups.includes(g));

  ctx.requireAdmin = (req, res) => {
    if (ctx.authEnabled && !ctx.isAdminUser(req.user)) {
      res.status(403).json({ error: "Admin group required" });
      return false;
    }
    return true;
  };

  // MCP mutation gate, deployment-shaped (extension-runtime-management spec):
  // the admin group in shared deployments; the owning user in a per-user
  // hosted cell, whose cell-local configuration store is theirs alone;
  // anyone when auth is off (machine owner, same as requireAdmin).
  const cellUserEmail = ctx.CLOUD_MODE ? String(process.env.CELL_USER_EMAIL || "") : "";
  ctx.cellUserEmail = cellUserEmail;
  ctx.requireMcpManage = (req, res) => {
    if (!ctx.authEnabled) return true;
    if (ctx.isAdminUser(req.user)) return true;
    if (cellUserEmail && req.user?.email === cellUserEmail) return true;
    res.status(403).json({ error: "Admin group or cell ownership required" });
    return false;
  };

  // Snapshot the cell owner's latest groups (write-on-change) so the next
  // cell boot can role-filter the boot MCP patch.
  if (cellUserEmail) {
    ctx.app.use((req, _res, next) => {
      if (req.user?.email === cellUserEmail) noteOwnerGroups(req.user);
      next();
    });
  }
}
