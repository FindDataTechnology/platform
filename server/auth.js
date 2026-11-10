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
import { LAYOUT_HEADER } from "./layout.js";
import {
  admissionView,
  composeAdmin,
  parseRoleHeaders,
  resolveAssignment,
} from "./roles.js";

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
//   /api/app/pair, /api/app/challenge, /api/app/login — the universal
//     client's device pairing (add-device-pairing-auth), same situation: no
//     browser session; each call authenticates through the bind code or the
//     device key's challenge signature. Inert (503) without MP_TOKEN_SECRET.
// Exported for the trust-boundary ledger check (scripts/test-auth-trust-boundary.mjs):
// the spec's prefix table and this array are two sides of one contract, and the
// check is what keeps them from drifting apart.
export const AUTH_EXEMPT_PREFIXES = [
  // Chart rendering asset for the mobile client's WebView (ChartView): a
  // <script src> fetch carries no Authorization header and no session cookie,
  // so an authenticated gate 401s it and every chart silently degrades
  // (acceptance lane, 2026-10-28). It is a public library file — no data.
  "/chart-assets/",
  "/api/bots/webhook/",
  "/api/bots/relay/",
  "/api/mp/login",
  "/api/mp/login-bindcode",
  "/api/app/pair",
  "/api/app/challenge",
  "/api/app/login",
  // Ops reads (add-pack-usage-telemetry): the pack-usage aggregate is an
  // ops-console data source on the internal network — same convention as the
  // bot prefixes above, the route carries its own bearer credential.
  "/api/ops/",
  // Local roster feed (add-local-fleet-control-plane): the agent-runner child
  // polls it over loopback with its OWN bearer (WANXING_LOCAL_FEED_TOKEN),
  // exactly like the cron/ops bridges above — the route verifies that token
  // itself, so the session gate must not intercept it first.
  "/local-registry/",
  // Trial-exec service channel (add-supply-studio-migration 5.3): the supply
  // domain's Studio calls the run domain headlessly over the shared internal
  // credential (x-facet-token, timing-safe compared in the route) — same
  // convention as /api/ops/: the route carries its own authentication, so the
  // session gate must not intercept it first. Inert (401) with no token.
  "/api/trial-exec",
  // Mandate verdict channel (add-principal-disclosure-gate 1.5): the runner asks
  // the cell "may this outbound text be sent", over a deployment-injected bearer
  // compared in constant time in the route. Deliberately NOT an internal bridge:
  // the runner is not loopback to the cell, and loosening `isInternalChild` to
  // cover it would create the weakest door in that table. Inert (503) with no
  // token configured — an unconfigured deployment refuses, never allows.
  "/api/actions/mandate-verdict",
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

// Exported for routes that enforce their own loopback posture (the local
// roster feed's token-less dev mode). One implementation, so a missed address
// form is fixed in one place rather than in each route's copy.
export const isLoopbackAddress = isLoopback;

// A bridge caller is the cell's OWN child: loopback AND carrying no proxied
// identity. Both halves are required. In hosted mode the gateway proxies every
// real user into their cell from 127.0.0.1 while injecting `x-forwarded-email`
// (gateway/index.js:1107 + gateway/proxy.js:59), so a loopback address alone
// does not tell the child apart from the owner: a real user whose UI gesture
// lands on a bridge path (the fleet drawer's "run now" hits /api/cron/:id/run,
// the board's propose hits /api/actions/propose) would be stamped with the
// bridge's machine identity — and where a route trusts an internal caller's
// body for the acting identity (/api/actions/propose reads `proposerEmail`),
// that is an identity the caller chooses. The absent header is the
// discriminator; a child calls loopback directly and never carries it.
const isInternalChild = (req) =>
  isLoopback(req.socket?.remoteAddress) && !req.headers["x-forwarded-email"];

// The verbs/paths the fleet MCP child drives (agent-fleet-report-lane +
// agent-fleet-decision-lane + agent-fleet-decision-delegate).
const FLEET_BRIDGE_PATHS = new Set([
  "/api/fleets/report",
  "/api/fleets/escalate",
  "/api/fleets/dispatch",
  "/api/fleets/deputy/queue",
  "/api/fleets/deputy/resolve",
  "/api/fleets/deputy/escalate-to-owner",
  // 审计官从自己回合提交结论（2026-11-10）。与 deputy 三件同款：归属在服务端
  // 按当次回合的 preset 解析，auditorGuard 再校验那个岗位确实是 auditor。
  "/api/fleets/auditor/verdict",
]);

// Every bridge the gate opens, in one table: the identity each stamps, how it
// matches, and its scope. Each matcher composes the SAME `isInternalChild`
// guard, so a new bridge cannot arrive with a weaker caller test — the failure
// this table fixes was five inline copies of one guard, one of which was
// missing the identity half for eight of ten bridges.
//
// `match` receives the request; `note` is the route-side attribution that keeps
// a forged loopback caller from acting as anyone it names.
export const INTERNAL_BRIDGES = [
  {
    // The cron MCP child (stdio, spawned by the dsh runtime inside this cell)
    // drives the engine over /api/cron.
    email: "cron@internal",
    match: (req) => req.path === "/api/cron" || req.path.startsWith("/api/cron/"),
    note: "routes act on this cell's own jobs",
  },
  {
    // `chart_bind` (add-chart-data-binding): a dsh-plugin tool declaring the data
    // call behind the chart this turn produced. Only ever acts on the CURRENT
    // turn's chart — it cannot name another session's.
    email: "chart-bridge@internal",
    match: (req) => req.path === "/api/resources/bind-declared",
    note: "acts on the current turn's chart only",
  },
  {
    // The delegation MCP child (add-agent-delegation-tools) drives the task
    // engine's manual path.
    email: "delegation@internal",
    match: (req) => req.path.startsWith("/api/delegation/"),
    note: "task engine's manual path, cell-scoped",
  },
  {
    // The architect MCP child (agent-fleet-architect) reads/drafts/applies fleet
    // structure; routes resolve the acting owner from the cell context.
    email: "fleet-architect@internal",
    match: (req) => req.path.startsWith("/api/fleet-architect/"),
    note: "acting owner resolved server-side from the cell context",
  },
  {
    // The blueprint-author and pack-author MCP children
    // (add-builder-team-templates) land VALIDATION-GREEN drafts into the owner's
    // pools; neither carries an approve/publish/mint verb — the owner's gates in
    // the Studio and the pack editor stay the only paths to effect.
    email: "builder-author@internal",
    match: (req) =>
      req.path.startsWith("/api/blueprint-author/") || req.path.startsWith("/api/pack-author/"),
    note: "draft landing only — no approve/publish/mint verb",
  },
  {
    // The skill-evolution MCP child (add-skill-self-evolution) lands CANDIDATES;
    // propose-only, because evaluate/promote/reject are the owner's gestures and
    // require a real user (which this stamp is not).
    email: "skill-evolution@internal",
    match: (req) => req.method === "POST" && req.path === "/api/skill-evolution/propose",
    note: "propose verb only — evaluate/promote/reject need a real user",
  },
  {
    // The persona-evolution twin (add-persona-self-evolution), same shape.
    email: "persona-evolution@internal",
    match: (req) => req.method === "POST" && req.path === "/api/persona-evolution/propose",
    note: "propose verb only, same rule as the skill lane",
  },
  {
    // `save_to_library` (add-save-to-library-tool): the dsh child ingests
    // workspace files the CURRENT turn produced; the route resolves the session
    // server-side.
    email: "save-bridge@internal",
    match: (req) => req.path === "/api/resources/save-declared",
    note: "session resolved server-side",
  },
  {
    // The actions MCP child (add-wire-line-board D4) creates a proposal for the
    // user named in its per-user profile env. ONE verb, and only a *pending*
    // proposal: approve/reject/query never take this door. Because the route
    // trusts `proposerEmail` from an internal caller, this entry is exactly why
    // the child guard must exclude identity-bearing proxied requests.
    email: "actions-bridge@internal",
    match: (req) => req.method === "POST" && req.path === "/api/actions/propose",
    note: "one verb, pending proposals only; proposer comes from the child's profile env",
  },
  {
    // The fleet MCP child (agent-fleet-report-lane + -decision-lane +
    // -decision-delegate) reports for / escalates from / dispatches as / rules as
    // the post the CURRENT turn runs under. Every route attributes server-side
    // from the running cluster task or live preset, and the deputy routes also
    // require the attributed post to BE the fleet's deputy (deputyGuard).
    email: "fleet-bridge@internal",
    match: (req) => req.method === "POST" && FLEET_BRIDGE_PATHS.has(req.path),
    note: "post attributed server-side; deputy routes guarded by deputyGuard",
  },
];

// The bridge identity for this request, or null when nothing bridges it.
export function internalBridgeEmail(req) {
  if (!isInternalChild(req)) return null;
  const hit = INTERNAL_BRIDGES.find((bridge) => bridge.match(req));
  return hit ? hit.email : null;
}

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
  // Business-role assignment (role-system) rides the SAME trust boundary: the
  // secret check above gates the identity pair, so the role headers are only
  // read after it passes. Carried only when present, so an identity arriving
  // without role headers keeps the exact pre-role-system shape. The deployment
  // layout layer (layout-configuration) travels the same way.
  const gatewayAssignment = parseRoleHeaders(headers);
  const gatewayLayout = parseLayoutHeader(headers);
  const identity = gatewayAssignment ? { email, groups, gatewayAssignment } : { email, groups };
  return gatewayLayout ? { ...identity, gatewayLayout } : identity;
}

// The deployment layout layer the gateway stamped (layout-configuration). Raw
// JSON — the cell parses it with the shared validator, so a malformed value
// degrades to "no header" rather than poisoning resolution.
export function parseLayoutHeader(headers) {
  const raw = headers?.[LAYOUT_HEADER];
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

// Attach the business-role assignment to an identity at the point it enters
// the request (role-system). The assignment source is the gateway's signed
// header when present, else the cell's local store / env seed; the `standard`
// fallback keeps a deployment without any role data byte-identical to before.
// Attach the business-role assignment to an identity at the point it enters
// the request (role-system). The assignment source is the gateway's signed
// header when present, else the cell's local store / env seed; the `standard`
// fallback keeps a deployment without any role data byte-identical to before.
// Exported for the WS connection path, which resolves identity itself.
export function withRoles(ctx, user) {
  if (!user) return user;
  const assignment = resolveAssignment({
    user,
    gatewayAssignment: user.gatewayAssignment ?? null,
    db: ctx.db ?? null,
    env: process.env,
  });
  const { gatewayAssignment: _drop, ...identity } = user;
  const withRolesUser = {
    ...identity,
    roles: { primary: assignment.primary, secondary: assignment.secondary },
    roleAdmin: assignment.admin === true,
    roleSource: assignment.source,
  };
  // Admission view (role-system D4): identity groups win when present; with
  // none, the roles' mapped groups stand in. Every existing visibility filter
  // reads `user.groups`, so substituting here is what grants role-mapped
  // admission without touching each filter.
  return admissionView(withRolesUser);
}

// Install the HTTP auth gate. forward_auth trusts proxy-injected identity;
// logto verifies the signed session cookie and ignores those headers.
export function registerAuth(ctx) {  ctx.app.use((req, res, next) => {
    const bridgeEmail = internalBridgeEmail(req);
    if (bridgeEmail) {
      req.user = { email: bridgeEmail, internal: true };
      return next();
    }
    const headerUser = userFromHeaders(req.headers, ctx.headerTrust);
    if (ctx.authMode === "logto") {
      // A verified MP Bearer token is a second door into the same identity:
      // cookie first (parity with the gateway's resolveUser), token fallback.
      if (isLogtoPublicRequest(req) || isExempt(req.path)) {
        const user = ctx.logtoAuth?.authenticate(req, res) || mpUserFromToken(ctx, req);
        if (user) req.user = withRoles(ctx, user);
        return next();
      }
      const user = ctx.logtoAuth?.authenticate(req, res) || mpUserFromToken(ctx, req);
      if (!user) {
        if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Authentication required" });
        if (req.accepts("html")) return res.redirect("/login");
        return res.status(401).json({ error: "Authentication required" });
      }
      req.user = withRoles(ctx, user);
      return next();
    }

    if (ctx.authEnabled) {
      // The app's paired-device Bearer is a second door into the same
      // identity under forward_auth too (logto's gate already does this;
      // without it, a forward_auth deployment can't serve the app at all —
      // first acceptance run, 2026-10-27).
      const user = headerUser ?? mpUserFromToken(ctx, req);
      if (isPublicRequest(req) || isExempt(req.path)) {
        if (user) req.user = withRoles(ctx, user);
        return next();
      }
      if (!user) return res.status(401).json({ error: "Authentication required" });
      req.user = withRoles(ctx, user);
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
  // Admin composition (role-system D3): the stored/header admin flag OR the
  // admin group — the group path is preserved verbatim, so a deployment that
  // never touches the role store answers exactly as before.
  ctx.isAdminUser = (user) =>
    composeAdmin({
      assignment: user?.roleAdmin === true ? { admin: true } : null,
      user,
      adminGroups: ctx.adminGroups,
    });

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
