// Desk embed routes (add-crm-desk-pack-embed task 6.x, design D6).
//
// Three surfaces, two origins:
//
//   PLATFORM ORIGIN (normal gateway Logto auth):
//   GET /external/desk/go — the app-center card's link. Checks the merchant's
//     connection state, mints a short-lived signed embed token, and 302s to
//     the desk-embed origin's /entry. No credentials → the connect panel.
//
//   DESK-EMBED ORIGIN (edge-routed sibling host; identity = the signed token,
//   gateway verifies it and injects identity headers — see gateway/index.js):
//   GET /external/desk/entry — establishes the user's upstream Chatwoot session
//     (server-side devise sign_in with the login pair from their connect
//     panel), sets the embed cookie, redirects into the SPA.
//   ALL /external/desk/* — reverse proxy to CHATWOOT_BASE_URL with the user's
//     devise headers injected; Set-Cookie passes through (lands on this
//     origin). Per-user session map, in-process only.
//
// KNOWN V1 LIMIT (honest): Chatwoot's ActionCable websocket (/cable) is not
// proxied — the dashboard works, live updates need a refresh. Wiring the
// upgrade through the gateway embed hook is the follow-up.
//
// All upstream calls use CHATWOOT_BASE_URL; the embed degrades honestly (readable
// error pages, never a half-open frame) when the deployment or the user is
// missing configuration.

import { signEmbedToken } from "../session.js";
import * as chatwootCredentials from "../../chatwoot-credentials.js";

// ── Platform API SSO (paas-embed-desk-requirements.md, task 6.x) ────────────
// The desk instance runs a Platform App (`paas-sso`); its token (deployment
// env CHATWOOT_PLATFORM_TOKEN, 带外) exchanges a per-user one-time login URL:
//   GET {base}/platform/api/v1/users/{id}/login  →  {url: ".../sso_auth_token=…"}
// Opening that URL logs the user into THEIR tenant with zero typing. This is
// the LIVE embed path (no edge subdomain needed); the reverse-proxy surfaces
// below remain the visual-embed upgrade path.

const SSO_TIMEOUT_MS = 10_000;

// Resolve the Chatwoot user id for the caller: the id behind THEIR stored API
// token (lazy /api/v1/profile discovery, cached on the credential row).
async function resolveChatwootUserId(email, base) {
  const cached = chatwootCredentials.chatwootUserId(email);
  if (cached) return cached;
  const token = chatwootCredentials.liveToken(email);
  if (!token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SSO_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/v1/profile`, {
      headers: { "Api-Access-Token": token },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const profile = await res.json();
    const id = Number(profile?.id);
    if (!Number.isInteger(id)) return null;
    chatwootCredentials.storeChatwootUserId(email, id);
    return id;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Exchange the user id for a one-time SSO login URL (server-side; the platform
// token never leaves this process).
async function ssoLoginUrl(userId, base) {
  const platformToken = process.env.CHATWOOT_PLATFORM_TOKEN;
  if (!platformToken) {
    throw Object.assign(new Error("平台未配置客服台 SSO（CHATWOOT_PLATFORM_TOKEN 缺失）"), { code: "not_configured" });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SSO_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/platform/api/v1/users/${userId}/login`, {
      headers: { "Api-Access-Token": platformToken },
      signal: controller.signal,
    });
    if (res.status === 404) {
      throw Object.assign(new Error("该账号尚未开通客服台 SSO（用户不在 Platform App 授权名单）"), { code: "not_provisioned" });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`上游错误：客服台 SSO 返回 ${res.status}`), { code: "upstream" });
    }
    const data = await res.json();
    if (typeof data?.url !== "string" || !data.url) {
      throw Object.assign(new Error("上游错误：客服台 SSO 响应缺少登录地址"), { code: "upstream" });
    }
    return data.url;
  } catch (err) {
    if (err?.code) throw err;
    throw Object.assign(new Error(`网络不可达：${err?.message || err}`), { code: "unreachable" });
  } finally {
    clearTimeout(timer);
  }
}

const EMBED_COOKIE = "desk_embed";
const EMBED_COOKIE_TTL_MS = 12 * 60 * 60 * 1000;
// Devise tokens expire (~14 days from issue); re-sign-in well before that.
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const SIGN_IN_TIMEOUT_MS = 10_000;

// email → { accessToken, client, uid, expiryAt }; process-local by design —
// sessions never persist and never cross users.
const sessions = new Map();

function identity(req) {
  return req.ssoUser || req.user || null;
}

function requireOwner(req, res, ctx) {
  if (!ctx.authEnabled) return true;
  if (!identity(req)?.email) {
    res.status(401).send("需要登录");
    return false;
  }
  return true;
}

function errorPage(res, status, title, detail) {
  res
    .status(status)
    .type("html")
    .send(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h2>${title}</h2><p style="color:#555">${detail}</p>
<p><a href="/settings/connections?panel=chatwoot">返回连接设置</a></p></body>`);
}

async function ensureUpstreamSession(email, baseUrl) {
  const hit = sessions.get(email);
  if (hit && hit.expiryAt > Date.now() + 60_000) return hit;
  const creds = chatwootCredentials.loginCredentials(email);
  if (!creds) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGN_IN_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}/auth/sign_in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: creds.email, password: creds.password }),
      signal: controller.signal,
    });
  } catch {
    throw Object.assign(new Error("网络不可达：客服台地址当前连不上"), { code: "unreachable" });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    throw Object.assign(new Error("凭据无效：登录邮箱或密码被客服台拒绝，请在连接面板补全"), { code: "unauthorized" });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`上游错误：客服台登录返回 ${res.status}`), { code: "upstream" });
  }
  const accessToken = res.headers.get("access-token");
  const client = res.headers.get("client");
  const uid = res.headers.get("uid");
  const expiry = res.headers.get("expiry");
  if (!accessToken || !client || !uid) {
    throw Object.assign(new Error("上游错误：客服台登录响应缺少会话头"), { code: "upstream" });
  }
  const session = {
    accessToken,
    client,
    uid,
    expiryAt: expiry ? Number(expiry) * 1000 : Date.now() + SESSION_TTL_MS,
  };
  sessions.set(email, session);
  return session;
}

// Headers we never forward in either direction (hop-by-hop + our own).
const DROP_REQ_HEADERS = new Set(["host", "connection", "content-length", "cookie", "origin", "referer"]);
const DROP_RES_HEADERS = new Set(["set-cookie", "transfer-encoding", "content-length", "connection", "x-frame-options"]);

function proxyTargetUrl(req, baseUrl) {
  const path = req.url.replace(/^\/external\/desk/, "") || "/";
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function upstreamHeaders(req, session) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (DROP_REQ_HEADERS.has(lower) || lower.startsWith("x-forwarded")) continue;
    if (lower === "accept-encoding") continue; // let fetch negotiate its own
    headers[name] = value;
  }
  if (session) {
    headers["access-token"] = session.accessToken;
    headers["client"] = session.client;
    headers["uid"] = session.uid;
    if (Number.isFinite(session.expiryAt)) headers["expiry"] = String(Math.floor(session.expiryAt / 1000));
    headers["token-type"] = "Bearer";
  }
  return headers;
}

export function registerDeskEmbedRoutes(ctx) {
  const { app, db } = ctx;
  const secret = () => process.env.CELL_GATEWAY_SECRET || "";
  const baseUrl = () => (process.env.CHATWOOT_BASE_URL || "").replace(/\/+$/, "");
  const embedOrigin = () => (process.env.DESK_EMBED_URL || "").replace(/\/+$/, "");

  // PLATFORM ORIGIN — the app-center card lands here.
  app.get("/external/desk/go", (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    const email = identity(req)?.email ?? null;
    if (!db.isDbReady()) return errorPage(res, 503, "平台存储不可用", "稍后再试。");
    const status = chatwootCredentials.status(email);
    if (!status.connected) {
      return res.redirect("/settings/connections?panel=chatwoot&deskReason=need-connect");
    }
    if (!status.hasLoginCredentials) {
      // Token-only user: the embed needs the login pair — point at the panel
      // now instead of a dead end at the entry (the entry keeps the 422 page
      // as the defensive layer).
      return res.redirect("/settings/connections?panel=chatwoot&deskReason=need-login");
    }
    if (!baseUrl()) return errorPage(res, 503, "客服台嵌入未配置", "本部署尚未配置 Chatwoot 地址，请联系平台管理员。");
    if (!embedOrigin() || !secret()) {
      return errorPage(res, 503, "客服台嵌入入口未就绪", "嵌入域名尚未配置（需平台管理员完成边缘路由）。可先直接访问客服台站点。");
    }
    const et = signEmbedToken(secret(), email ?? "machine-owner");
    res.redirect(`${embedOrigin()}/entry?et=${encodeURIComponent(et)}`);
  });

  // PLATFORM ORIGIN — the LIVE embed path: Platform API SSO exchange.
  // Connected user → one-time login URL for THEIR tenant → 302. No credential
  // (no mapping) → the honest 未开通 page. The platform token and the one-time
  // URL never appear in logs or responses beyond the redirect target itself.
  app.get("/external/crm-desk/sso", async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    const email = identity(req)?.email ?? null;
    if (!db.isDbReady()) return errorPage(res, 503, "平台存储不可用", "稍后再试。");
    const base = baseUrl();
    if (!base) return errorPage(res, 503, "客服台嵌入未配置", "本部署尚未配置 Chatwoot 地址，请联系平台管理员。");
    if (!chatwootCredentials.status(email).connected) {
      // 无映射/未连接 → 未开通客服台（spec fallback）
      return errorPage(res, 404, "尚未开通客服台", "你的壹座账号还没有连接 Chatwoot 凭据——先在 设置 → 连接 → CRM 客服台 完成连接，即可从这里免密进入你的客服台。");
    }
    try {
      const userId = await resolveChatwootUserId(email, base);
      if (!userId) {
        return errorPage(res, 401, "客服台凭据无效", "你在连接面板保存的 token 被客服台拒绝，请重新粘贴后再试。");
      }
      const url = await ssoLoginUrl(userId, base);
      return res.redirect(url);
    } catch (err) {
      if (err.code === "not_provisioned") {
        return errorPage(res, 403, "尚未开通客服台 SSO", err.message);
      }
      if (err.code === "not_configured") {
        return errorPage(res, 503, "客服台 SSO 未配置", err.message);
      }
      return errorPage(res, 502, "客服台暂时不可用", err.message);
    }
  });

  // DESK-EMBED ORIGIN — session bootstrap.
  app.get("/external/desk/entry", async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    const email = identity(req)?.email ?? null;
    if (!baseUrl()) return errorPage(res, 503, "客服台嵌入未配置", "本部署尚未配置 Chatwoot 地址。");
    if (!chatwootCredentials.status(email).connected) {
      return res.redirect("/settings/connections?panel=chatwoot&deskReason=need-connect");
    }
    if (!chatwootCredentials.loginCredentials(email)) {
      return errorPage(res, 422, "缺少登录凭据", "嵌入需要登录邮箱/密码（连接面板选填项），补全后即可一键进入。");
    }
    try {
      await ensureUpstreamSession(email, baseUrl());
    } catch (err) {
      if (err.code === "unauthorized") {
        chatwootCredentials.markInvalid(email);
        return errorPage(res, 401, "登录凭据无效", err.message);
      }
      return errorPage(res, 502, "客服台暂时不可用", err.message);
    }
    // The gateway verifies this cookie on the embed host for every later
    // request (see gateway/index.js desk-embed hook).
    const et = signEmbedToken(secret(), email ?? "machine-owner", EMBED_COOKIE_TTL_MS);
    res.setHeader("Set-Cookie", `${EMBED_COOKIE}=${encodeURIComponent(et)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${EMBED_COOKIE_TTL_MS / 1000}`);
    res.redirect("/app/");
  });

  // DESK-EMBED ORIGIN — the reverse proxy itself.
  app.all(/\/external\/desk\/.*/, async (req, res) => {
    if (!requireOwner(req, res, ctx)) return;
    if (req.path === "/external/desk/go" || req.path === "/external/desk/entry") return; // handled above
    const email = identity(req)?.email ?? null;
    const base = baseUrl();
    if (!base) return errorPage(res, 503, "客服台嵌入未配置", "本部署尚未配置 Chatwoot 地址。");
    if (req.method === "OPTIONS") {
      // The SPA is same-origin on the embed host; preflights only appear from
      // stray cross-origin callers — answer plainly.
      return res.status(204).end();
    }
    let session;
    try {
      session = await ensureUpstreamSession(email, base);
    } catch (err) {
      if (err.code === "unauthorized") {
        sessions.delete(email);
        return errorPage(res, 401, "登录凭据无效", `${err.message}（嵌入会话已结束）`);
      }
      return errorPage(res, 502, "客服台暂时不可用", err.message);
    }
    if (!session) {
      // No stored login pair: never proxy unauthenticated — that would read
      // the upstream with SOMEONE ELSE'S session or none at all.
      return errorPage(res, 401, "缺少登录凭据", "嵌入需要登录邮箱/密码（连接面板选填项），补全后即可进入。");
    }
    // Buffer the request body (Chatwoot API bodies are small JSON/form payloads;
    // the duplex-streaming fetch surface is not worth it here).
    const reqBody = ["GET", "HEAD"].includes(req.method)
      ? undefined
      : await new Promise((resolve, reject) => {
          const chunks = [];
          req.on("data", (c) => chunks.push(c));
          req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
          req.on("error", reject);
        });
    let upstream;
    try {
      // Exempt from the shared fetch timeout (harden-cell-execution-reliability):
      // reverse-proxy pass-through — the upstream body streams verbatim to the
      // browser and may be long-lived (attachments, SSE); bounding it would cut
      // real sessions mid-transfer. Header readability is guarded by the
      // try/catch below answering a 502 page.
      upstream = await fetch(proxyTargetUrl(req, base), {
        method: req.method,
        headers: upstreamHeaders(req, session),
        body: reqBody,
        redirect: "manual",
      });
    } catch (err) {
      return errorPage(res, 502, "客服台暂时不可用", `网络不可达：${err?.message || err}`);
    }
    const headers = {};
    upstream.headers.forEach((value, name) => {
      if (!DROP_RES_HEADERS.has(name.toLowerCase())) headers[name] = value;
    });
    // Pass upstream cookies through (domain-less ⇒ they land on this origin).
    const setCookies = upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : [];
    if (setCookies.length) headers["set-cookie"] = setCookies;
    res.status(upstream.status);
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    try {
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.end(buffer);
    } catch {
      res.end();
    }
  });
}
