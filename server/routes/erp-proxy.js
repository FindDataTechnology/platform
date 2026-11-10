// ── ERP 纵向 REST 服务面同源代理（add-erp-supply-chain-gateway-proxy）────────
//
// 页面打 `https://<platform-origin>/erp/supply-chain/v1/*`，平台把该前缀原样
// 代理到集群内的 fd-erp-vertical-api（ClusterIP，不对外暴露）。契约见
// finddata `openspec/changes/serve-erp-vertical-api` design D3。
//
// **本文件的核心是身份头纪律**：fd-erp-vertical-api 的 `X-ERP-Tenant` /
// `X-ERP-Customer|Staff|Supplier|Carrier` 目前是「底座登录态落地前的演示形态」，
// 谁都能填。挂到公网 origin 后若不剥离，任何登录用户都能自封供应商/承运商身份、
// 读他人单据。因此这里**只做三件事**：
//   1. 客户端送来的一切 `X-ERP-*` 头一律丢弃（不转发给上游）；
//   2. 用平台会话解出的身份**重新注入**（租户 + 该会话在绑定表里的角色标识）；
//   3. 无会话 → 401，不做匿名兜底（fail-closed）。
//
// 未绑定某角色 = 不注入该头 = 服务侧如实 401/404。这不是 bug：宁可不给，也不猜。
//
// 上游路径保持全前缀（服务侧路由就挂在 /erp/supply-chain/v1 下），不做重写。

import fs from "node:fs";
import path from "node:path";

export const ERP_PROXY_PREFIX = "/erp/supply-chain/v1";

// 客户端可自带、服务端必须重算的身份头（全部小写，Node 的 headers 是小写键）
const CLIENT_IDENTITY_HEADERS = [
  "x-erp-tenant",
  "x-erp-customer",
  "x-erp-staff",
  "x-erp-supplier",
  "x-erp-carrier",
];

// 逐跳头 + 由 fetch 重算的头：转发它们会破坏连接语义
const DROP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
]);

// 页面集 → 身份头名（与 fd-erp-vertical-api 的 faces/pagesets 一一对应）
const IDENTITY_BY_PAGESET = {
  "supply-chain.ue": "x-erp-customer",
  "supply-chain.se": "x-erp-staff",
  "supply-chain.sp": "x-erp-supplier",
  "supply-chain.cp": "x-erp-carrier",
};

function unifiedError(res, status, code, message, hint = "") {
  return res.status(status).json({
    ok: false,
    error: { code, message, hint, detail: {} },
    rows_returned: 0,
  });
}

/**
 * 读身份绑定表：{ "<email>": { customer?, staff?, supplier?, carrier? } }。
 * 缺失/损坏 → 空表（fail-closed：谁都拿不到角色身份，服务侧如实 401/404）。
 */
export function loadIdentityBindings(filePath) {
  if (!filePath) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out = {};
    for (const [email, roles] of Object.entries(raw)) {
      if (!roles || typeof roles !== "object" || Array.isArray(roles)) continue;
      const clean = {};
      for (const key of ["customer", "staff", "supplier", "carrier"]) {
        const value = roles[key];
        if (typeof value === "string" && value.trim()) clean[key] = value.trim();
      }
      if (Object.keys(clean).length) out[String(email).trim().toLowerCase()] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 一次请求该注入哪些身份头。
 *
 * - 租户：部署级常量（一进程一租户；跨租户由服务侧 403 TENANT_DENIED 兜底）
 * - SE 的 staff：会话账号本身（业务员就是登录人）——可用绑定表覆盖
 * - UE/SP/CP：只认绑定表（客户/供应商/承运商是**组织**，不是登录人，猜不得）
 */
export function resolveIdentityHeaders(user, { tenantId, bindings, defaultCustomer }) {
  const headers = {};
  if (tenantId) headers["x-erp-tenant"] = tenantId;
  if (!user?.email) return headers;
  const roles = bindings[String(user.email).trim().toLowerCase()] || {};
  headers["x-erp-staff"] = roles.staff || user.email;
  if (roles.customer) headers["x-erp-customer"] = roles.customer;
  else if (defaultCustomer) headers["x-erp-customer"] = defaultCustomer;
  if (roles.supplier) headers["x-erp-supplier"] = roles.supplier;
  if (roles.carrier) headers["x-erp-carrier"] = roles.carrier;
  return headers;
}

/**
 * 构造代理中间件。挂在 app.use(ERP_PROXY_PREFIX, ...)，因此 req.url 只剩子路径。
 *
 * @param {object} opts
 * @param {string} opts.upstream    上游基址，如 http://fd-erp-vertical-api.fd-prod.svc.cluster.local
 * @param {string} opts.tenantId    ERP_TENANT_ID（部署级常量）
 * @param {object} opts.bindings    会话邮箱 → 角色标识（见 loadIdentityBindings）
 * @param {string} [opts.defaultCustomer] 单客户部署的默认客户（演示形态；不设则不注入）
 * @param {boolean|function} opts.authEnabled 平台是否开启了会话鉴权
 * @param {number} [opts.timeoutMs]
 * @param {function} [opts.fetchImpl]
 */
export function createErpProxy(opts) {
  const {
    upstream,
    tenantId = "",
    bindings = {},
    defaultCustomer = "",
    authEnabled = true,
    timeoutMs = 20_000,
    fetchImpl = globalThis.fetch,
  } = opts;

  const base = String(upstream || "").replace(/\/+$/, "");

  return async function erpProxy(req, res) {
    const isAuthOn = typeof authEnabled === "function" ? !!authEnabled() : !!authEnabled;
    // fail-closed：开启鉴权时没有会话一律 401（GET 也不会因为「非 /api 前缀算公开」
    // 而漏过——全局闸对 /erp 的 GET 是放行的，所以这一道必须在本文件里）。
    if (isAuthOn && !req.user?.email) {
      return unifiedError(res, 401, "AUTH_REQUIRED", "需要登录会话", "请先登录后再访问业务接口。");
    }
    if (!base) {
      return unifiedError(
        res,
        503,
        "UPSTREAM_NOT_CONFIGURED",
        "ERP 服务地址未配置",
        "部署侧需设置 ERP_API_UPSTREAM（集群内 Service 地址）。",
      );
    }

    // 1) 转发头：一律丢掉客户端自带的身份头与逐跳头
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const name = key.toLowerCase();
      if (CLIENT_IDENTITY_HEADERS.includes(name)) continue; // 剥离
      if (DROP_HEADERS.has(name)) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    // 2) 服务端注入
    const injected = resolveIdentityHeaders(req.user, { tenantId, bindings, defaultCustomer });
    for (const [name, value] of Object.entries(injected)) headers[name] = value;
    // 3) 客户端 IP 透传（审计用；服务侧不据此授权）
    const remote = req.socket?.remoteAddress;
    if (remote) headers["x-forwarded-for"] = headers["x-forwarded-for"] || remote;

    // 请求体：本前缀在 server.js 的 body parser 之前被跳过，这里读原始字节
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const body = hasBody ? await readRawBody(req) : undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstreamRes = await fetchImpl(`${base}${req.originalUrl || req.url}`, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      clearTimeout(timer);
      res.status(upstreamRes.status);
      // 上游的 content-encoding 已由 fetch 解压，不能照搬
      upstreamRes.headers.forEach((value, key) => {
        if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)) return;
        res.setHeader(key, value);
      });
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      return res.end(buf);
    } catch (err) {
      clearTimeout(timer);
      const aborted = err?.name === "AbortError";
      return unifiedError(
        res,
        aborted ? 504 : 502,
        aborted ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNREACHABLE",
        aborted ? "ERP 服务响应超时" : "ERP 服务不可达",
        aborted ? "稍后重试；持续超时请查 ERP 服务实例。" : "查 Pod 是否 Ready 与 Service 是否可达。",
      );
    }
  };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * 挂载入口，两种进程形态共用同一份实现：
 *   - 单进程（自托管 `node server.js`）：会话由上层中间件写进 `req.user`，不传 resolveUser；
 *   - 多租户网关（产上 `node gateway/index.js` 持有 origin 端口 3100）：网关在路由里才解会话，
 *     传 `resolveUser` 让本函数先把它落成 `req.user`（代理只认 `req.user`，不认裸 cookie）。
 *
 * 产上 3100 的 SPA 兜底在 gateway/index.js:322 —— 代理必须在那之前挂，否则 `/erp/*`
 * 被前端 shell 抢走返回 index.html（首轮上产实测：GET 200 text/html 1298 字节）。
 */
export function registerErpProxyRoutes(ctx) {
  const { app, resolveUser } = ctx;
  const env = ctx.env ?? process.env;
  const enabled = String(env.ERP_API_PROXY_ENABLED ?? "").toLowerCase();
  if (enabled === "0" || enabled === "false") return; // 显式关掉（其它部署形态）

  const upstream = env.ERP_API_UPSTREAM || "http://fd-erp-vertical-api.fd-prod.svc.cluster.local";
  const bindingsPath =
    env.ERP_IDENTITY_BINDINGS_FILE || path.join(process.env.FD_DATA_DIR || "data", "erp-identities.json");

  if (typeof resolveUser === "function") {
    app.use(ERP_PROXY_PREFIX, (req, _res, next) => {
      const user = resolveUser(req);
      if (user) req.user = user;
      next();
    });
  }

  app.use(
    ERP_PROXY_PREFIX,
    createErpProxy({
      upstream,
      tenantId: env.ERP_TENANT_ID || "acme",
      bindings: loadIdentityBindings(bindingsPath),
      defaultCustomer: env.ERP_DEFAULT_CUSTOMER || "",
      // 鉴权开关按请求读：与 boards.js 同一约定，改 env 不必重启
      authEnabled: () => ctx.authEnabled !== false,
    }),
  );
}

export { IDENTITY_BY_PAGESET };
