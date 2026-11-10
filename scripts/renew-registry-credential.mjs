#!/usr/bin/env node
// 注册处用户凭证自动续期（openspec: renew-registry-credential-automation 1.1–1.3）
//
// 背景：注册处 `POST /api/tokens/generate` 的用户 JWT 最长 7 天，过期后该账号名下
// 的 registry-origin MCP 源会整批消失（profile 里报 "no live credential"）。人工
// 每 7 天点一次不现实，本脚本把它变成定时任务。
//
// 全链（2026-11-08 实摸）：Logto Experience API 登录 → 注册处铸 token → 平台侧
// `POST /api/registry/credential` 写入（**不直写 cell 库**）→ 用新 token 对若干
// registry 源真打 MCP `initialize`，全 200 才算成功。
//
// 用法：
//   RENEW_EMAIL=bot@… RENEW_PASSWORD=… node scripts/renew-registry-credential.mjs
//   … --dry-run          # 只登录 + 铸 token，不写入、不打握手
//   … --verify-only TOK  # 只做握手验证（排查用）
//
// 退出码：0 成功；1 某步失败（含握手非 200）。任何失败都**不覆盖**已有凭证——
// 写库只发生在 mint 成功后，且失败分支不写。
//
// 纪律：口令与 token 一律不落日志；打印只出步骤名与状态码。

import { existsSync, readFileSync } from "node:fs";

const REGISTRY = (process.env.REGISTRY_BASE || "https://mcp.finddatatech.cloud").replace(/\/+$/, "");
const PLATFORM = (process.env.PLATFORM_BASE || "https://platform.finddatatech.cloud").replace(/\/+$/, "");
const AUTH = (process.env.LOGTO_BASE || "https://auth.finddatatech.cloud").replace(/\/+$/, "");
const TTL_HOURS = Number(process.env.RENEW_TTL_HOURS || 168);
const VERIFY_SERVERS = (process.env.RENEW_VERIFY_SERVERS
  || "fd-erp-ledger-mcp,fd-open-data-mcp,fd-daas-mcp").split(",").map((s) => s.trim()).filter(Boolean);
const DRY_RUN = process.argv.includes("--dry-run");
const verifyOnlyIdx = process.argv.indexOf("--verify-only");
const VERIFY_ONLY = verifyOnlyIdx !== -1 ? process.argv[verifyOnlyIdx + 1] : null;

// ── 极简 cookie jar（按 host 存；两个域各自带自己的 cookie）────────────────────
export function makeJar() {
  const byHost = new Map();
  return {
    set(url, setCookieHeaders) {
      const host = new URL(url).host;
      const jar = byHost.get(host) ?? new Map();
      for (const raw of setCookieHeaders || []) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      byHost.set(host, jar);
    },
    header(url) {
      const jar = byHost.get(new URL(url).host);
      if (!jar || jar.size === 0) return "";
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get(url, name) {
      return byHost.get(new URL(url).host)?.get(name) ?? null;
    },
  };
}

// ── 带 jar + 手动跟随重定向的请求（跨域 cookie 必须由我们自己带）──────────────
export async function request(url, { method = "GET", headers = {}, body, jar, maxHops = 10, fetchImpl = fetch } = {}) {
  let current = url;
  let curMethod = method;
  let curBody = body;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const cookie = jar.header(current);
    const res = await fetchImpl(current, {
      method: curMethod,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(curBody ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: curBody,
      redirect: "manual",
    });
    const setCookies = typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean);
    jar.set(current, setCookies);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { res, url: current };
      current = new URL(loc, current).toString();
      // 重定向后的 GET 不再带 body（HTTP 语义）
      if (res.status === 303 || res.status === 302 || res.status === 301) {
        curMethod = "GET";
        curBody = undefined;
      }
      continue;
    }
    return { res, url: current };
  }
  throw new Error(`too many redirects from ${url}`);
}

export function parseCsrf(html) {
  const m = html.match(/name=["']csrf_token["'][^>]*value=["']([^"']+)["']/i)
    || html.match(/csrf[_-]?token["']?\s*[:=]\s*["']([A-Za-z0-9._~-]{20,})["']/i);
  return m ? m[1] : null;
}

function decodeJwtExp(token) {
  try {
    const [, payload] = token.split(".");
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json.exp === "number" ? new Date(json.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

const step = (name, ok, extra = "") => console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` ${extra}` : ""}`);

// ── ① Logto 登录（拿注册处会话）───────────────────────────────────────────────
export async function registryLogin(jar, { email, password, fetchImpl = fetch } = {}) {
  const start = `${REGISTRY}/api/auth/auth/logto`;
  const { res, url } = await request(start, { jar, fetchImpl });
  if (!/\/sign-in/.test(url) && res.status !== 200) {
    throw new Error(`registry login start failed (${res.status}) at ${url}`);
  }
  const exp = await request(`${AUTH}/api/experience`, {
    method: "PUT", body: JSON.stringify({ interactionEvent: "SignIn" }), jar, fetchImpl,
  });
  if (exp.res.status >= 400) throw new Error(`experience init failed (${exp.res.status})`);
  const ver = await request(`${AUTH}/api/experience/verification/password`, {
    method: "POST",
    body: JSON.stringify({ identifier: { type: "email", value: email }, password }),
    jar, fetchImpl,
  });
  const verBody = await ver.res.json().catch(() => ({}));
  if (ver.res.status >= 400) {
    const code = verBody?.code || `http_${ver.res.status}`;
    throw new Error(`password verification rejected: ${code}`);
  }
  const verificationId = verBody.verificationId;
  if (!verificationId) throw new Error("password verification returned no verificationId");
  // 必须先 POST /identification 把身份落到交互会话，否则 submit 报
  // `session.identifier_not_found`（2026-11-08 实测：这一步漏了就只能看到
  // verificationId 200 却 submit 404）。identify 返回 204。
  const ident = await request(`${AUTH}/api/experience/identification`, {
    method: "POST", body: JSON.stringify({ verificationId }), jar, fetchImpl,
  });
  if (ident.res.status >= 400) {
    throw new Error(`identification failed (${ident.res.status})`);
  }
  // submit 是 **POST**（PUT 返回 405 Method Not Allowed —— 2026-11-08 实测）。
  const sub = await request(`${AUTH}/api/experience/submit`, {
    method: "POST", body: JSON.stringify({ verificationId }), jar, fetchImpl,
  });
  const subBody = await sub.res.json().catch(() => ({}));
  const redirectTo = subBody.redirectTo;
  if (!redirectTo) throw new Error("submit returned no redirectTo");
  const back = await request(redirectTo, { jar, fetchImpl });
  // 回到注册处 /api/auth/callback：成功会 302 到 "/"
  if (back.res.status >= 400) throw new Error(`registry callback failed (${back.res.status})`);
  return { ok: true };
}

// ── ② 铸 token（CSRF 走 /api/auth/csrf-token —— SPA 用的就是这一条）──────────
//
// 2026-11-08 实测的三条死路，别再试：
//   ① `/api/tokens` 页面**不**渲染 csrf_token（handler 上下文里没有），模板
//      `token_generation.html` 自己也只发 Content-Type、不带 CSRF 头；
//   ② 唯一的 csrf 渲染点在服务端 `index.html`，但 `/` 被 Caddy 的 SPA 外壳
//      （889 字节）盖住，取不到；
//   ③ 用 Bearer 绕 CSRF 不行：`enhanced_auth` 只认 session cookie，Bearer 直接
//      401「Authentication required」（CSRF 的「无 cookie 跳过」分支走不到）。
// 正解：SPA 自己的做法 —— GET /api/auth/csrf-token 拿 `{csrf_token}`，再把它放进
// `X-CSRF-Token` 打 generate。实测 200 + 7 天 TTL。
export async function mintToken(jar, { ttlHours = TTL_HOURS, fetchImpl = fetch } = {}) {
  const csrfRes = await request(`${REGISTRY}/api/auth/csrf-token`, { jar, fetchImpl });
  const csrfBody = await csrfRes.res.json().catch(() => ({}));
  const csrf = csrfBody.csrf_token || csrfBody.csrfToken || csrfBody.token;
  if (csrfRes.res.status >= 400 || !csrf) {
    throw new Error(`csrf-token unavailable (${csrfRes.res.status})`);
  }
  const gen = await request(`${REGISTRY}/api/tokens/generate`, {
    method: "POST",
    body: JSON.stringify({ expires_in_hours: ttlHours, description: "auto-renew (cron)" }),
    headers: { "x-csrf-token": csrf },
    jar, fetchImpl,
  });
  const body = await gen.res.json().catch(() => ({}));
  const token = body?.tokens?.access_token || body?.access_token;
  if (gen.res.status >= 400 || !token) {
    throw new Error(`token generate failed (${gen.res.status})`);
  }
  return body.tokens.access_token;
}

// ── ③ 平台侧写入（不直写库；平台负责投影与 profile 重算）─────────────────────
export async function platformLogin(jar, { email, password, fetchImpl = fetch } = {}) {
  const { url } = await request(`${PLATFORM}/auth/login`, { jar, fetchImpl });
  if (/\/sign-in/.test(url)) {
    // 平台自己的 Logto 应用独立走一次 Experience API（SSO 会话可能已让 authorize 直接回跳）
    await request(`${AUTH}/api/experience`, {
      method: "PUT", body: JSON.stringify({ interactionEvent: "SignIn" }), jar, fetchImpl,
    });
    const ver = await request(`${AUTH}/api/experience/verification/password`, {
      method: "POST",
      body: JSON.stringify({ identifier: { type: "email", value: email }, password }),
      jar, fetchImpl,
    });
    const j = await ver.res.json().catch(() => ({}));
    if (ver.res.status >= 400) throw new Error(`platform password rejected: ${j?.code || ver.res.status}`);
    const ident2 = await request(`${AUTH}/api/experience/identification`, {
      method: "POST", body: JSON.stringify({ verificationId: j.verificationId }), jar, fetchImpl,
    });
    if (ident2.res.status >= 400) throw new Error(`platform identification failed (${ident2.res.status})`);
    const sub = await request(`${AUTH}/api/experience/submit`, {
      method: "POST", body: JSON.stringify({ verificationId: j.verificationId }), jar, fetchImpl,
    });
    const sj = await sub.res.json().catch(() => ({}));
    if (!sj.redirectTo) throw new Error("platform submit returned no redirectTo");
    await request(sj.redirectTo, { jar, fetchImpl });
  }
  if (!jar.get(PLATFORM, "paas_session")) throw new Error("platform session cookie not established");
  return { ok: true };
}

export async function writeCredential(jar, token, { fetchImpl = fetch } = {}) {
  const r = await request(`${PLATFORM}/api/registry/credential`, {
    method: "POST",
    body: JSON.stringify({ token, source: "paste" }),
    jar, fetchImpl,
  });
  const body = await r.res.json().catch(() => ({}));
  if (r.res.status >= 400) throw new Error(`credential write failed (${r.res.status})`);
  return body;
}

// ── ④ 真握手验证（成功判据；不看库）────────────────────────────────────────
export async function verifyServers(token, servers = VERIFY_SERVERS, { fetchImpl = fetch } = {}) {
  const failed = [];
  for (const name of servers) {
    const res = await fetchImpl(`${REGISTRY}/${name}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "renew", version: "1" } },
      }),
    });
    if (res.status !== 200) failed.push(`${name}:${res.status}`);
  }
  return { failed, total: servers.length };
}

async function main() {
  if (VERIFY_ONLY) {
    const { failed, total } = await verifyServers(VERIFY_ONLY);
    step(`handshake ${total - failed.length}/${total}`, failed.length === 0, failed.join(","));
    return failed.length === 0 ? 0 : 1;
  }
  const email = process.env.RENEW_EMAIL;
  const password = process.env.RENEW_PASSWORD;
  if (!email || !password) {
    console.error("缺少 RENEW_EMAIL / RENEW_PASSWORD（从 Secret 注入，不落盘）");
    return 2;
  }
  const jar = makeJar();
  try {
    await registryLogin(jar, { email, password });
    step("registry login", true);
  } catch (e) {
    step("registry login", false, `→ ${e.message}`);
    return 1;
  }
  let token;
  try {
    token = await mintToken(jar);
    step("mint token", true, `exp=${decodeJwtExp(token) ?? "?"}`);
  } catch (e) {
    step("mint token", false, `→ ${e.message}`);
    return 1;
  }
  if (DRY_RUN) {
    step("dry-run: skip write + verify", true);
    return 0;
  }
  try {
    await platformLogin(jar, { email, password });
    step("platform login", true);
  } catch (e) {
    step("platform login", false, `→ ${e.message}`);
    return 1;
  }
  try {
    const st = await writeCredential(jar, token);
    step("write credential", true, `expiresAt=${st?.expiresAt ?? "?"} connected=${st?.connected}`);
  } catch (e) {
    step("write credential", false, `→ ${e.message}`);
    return 1;
  }
  const { failed, total } = await verifyServers(token);
  step(`handshake ${total - failed.length}/${total}`, failed.length === 0, failed.join(","));
  if (failed.length) return 1;
  step("done", true);
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const code = await main();
  process.exit(code);
}

export { existsSync, readFileSync };
