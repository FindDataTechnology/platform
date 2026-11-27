// Per-user MCP-market credential API (registry-sso-credentials).
//
// The token is write-only from the browser's perspective: every response here
// carries connection state and expiry only. Reads and writes are keyed to the
// requesting identity's email; auth off falls back to the single-user machine
// owner (dev/desktop), where there is no one else to key it to.

import { getRegistryUrl, getRegistryLoginPath, getRegistryMint } from "../../registry-bridge.js";
import * as registryCredentials from "../../registry-credentials.js";
import * as callerGroup from "../../caller-group.js";

function identity(req) {
  return req.ssoUser || req.user || null;
}

// Anonymous writes are rejected in hosted mode: a credential row decides which
// token the runtime injects into a registry-origin MCP connection, so it must
// belong to an authenticated user. Auth off = the machine owner, allowed.
function requireOwner(req, res, ctx) {
  if (!ctx.authEnabled) return true;
  if (!identity(req)?.email) {
    res.status(401).json({ error: "Authentication is required" });
    return false;
  }
  return true;
}

function connectionPayload(email) {
  return {
    ...registryCredentials.status(email),
    // Where the connect popup should sign in and mint. Deployment config, not
    // a secret — the browser needs it to open the registry at all.
    registryUrl: getRegistryUrl(),
    loginPath: getRegistryLoginPath(),
    // Where the popup mints; empty registryUrl means the source is disabled
    // and the UI offers the paste fallback alone.
    mint: getRegistryMint(),
  };
}

// A credential change IS an effective-profile change: registry-origin servers
// appear (or disappear) at the next patch write, with no reinstall. Answer the
// request first and let the hot-swap settle in the background — the same shape
// the extensions routes use.
// 2026-11-08 产上回归（35 源 → 30 源）：`dsh-profile.js` 的可见性门是
//   `row.requiredGroups?.length && userGroups !== null && !userGroups.some(...)`
// —— 传 **null** 表示「组未知，不过滤」，传 **[]** 表示「没有任何组」，会把
// requiredGroups 里登记过的源整批删掉。凭证写入的会话常常拿不到组织的
// `organizations` claim（Experience API 登录 / SSO 直通都可能缺），于是一次续期就把
// fd-open-data-mcp / fd-daas-mcp / fd-cn-report / fd-find-data-business-mcp /
// fd-text-core 这批按组可见的源静默摘掉，岗位侧表现为「取数面变少」，且日志里
// 只有 omit 行、没有报错。
// 口径：**凭证变更绝不允许让 profile 变窄**。空组集一律按「未知」处理，
// 交给下一次带真实组的写入去收敛。
export function profileGroupsForReapply(groups) {
  return Array.isArray(groups) && groups.length ? groups : null;
}

function reapplyProfile(ctx, email, groups) {
  ctx
    .dshUpdateMcp?.(ctx.runtimeMcpOverlay ?? null, profileGroupsForReapply(groups), email)
    ?.catch((e) => console.warn(`[registry] profile update failed: ${e.message}`));
}

export function registerRegistryRoutes(ctx) {
  const { app, db } = ctx;

  app.get("/api/registry/connection", (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Registry credentials are disabled (database unavailable)" });
    }
    res.json(connectionPayload(identity(req)?.email ?? null));
  });

  // Store a credential: the mint handoff from the connect popup, or a manual
  // paste. Both write the same row and resolve injection identically.
  app.post("/api/registry/credential", (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Registry credentials are disabled (database unavailable)" });
    }
    const { token, expiresAt, source } = req.body || {};
    if (typeof token !== "string" || !token.trim()) {
      return res.status(400).json({ error: "Missing token" });
    }
    // Sanity cap: a JWT is well under this, and the row is not a blob store.
    if (token.length > 8192) {
      return res.status(400).json({ error: "Token is too long" });
    }
    const user = identity(req);
    const status = registryCredentials.store({
      email: user?.email ?? null,
      token,
      expiresAt,
      source,
    });
    if (!status) {
      return res.status(500).json({ error: "Failed to store the credential" });
    }
    res.json(status);
    reapplyProfile(ctx, user?.email ?? null, user?.groups ?? null);
    // C-lite (add-agent-platform-ops D5): fire-and-forget — the stored
    // personal credential gains agent-invoke attribution on the registry.
    // Failure never blocks the connect (market MCP keeps working).
    {
      const { assignCallerGroup, marketAdminFetch } = callerGroup;
      void assignCallerGroup({
        email: user?.email ?? null,
        token,
        adminFetch: marketAdminFetch({
          registryUrl: process.env.MARKET_REGISTRY_URL || process.env.REGISTRY_URL || "",
          token: process.env.MARKET_REGISTRY_TOKEN || process.env.AGENT_SERVING_REGISTRY_TOKEN || "",
        }),
      }).catch(() => {});
    }
  });

  // Disconnect: the row goes away, so the next profile write omits
  // registry-origin servers (their installed records stay).
  app.delete("/api/registry/connection", (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Registry credentials are disabled (database unavailable)" });
    }
    const user = identity(req);
    registryCredentials.disconnect(user?.email ?? null);
    res.json({ ok: true, ...connectionPayload(user?.email ?? null) });
    reapplyProfile(ctx, user?.email ?? null, user?.groups ?? null);
  });
}
