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
import { bearerFrom, verifyGrant } from "../grant-verify.js";
import path from "node:path";

export const ERP_PROXY_PREFIX = "/erp/supply-chain/v1";
//: 店面公开面前缀。与 ERP 后台分开挂载：身份模型不同（匿名 vs fail-closed）。
export const SHOP_PROXY_PREFIX = "/shop";

/**
 * 店面该发往哪个上游：与 ERP 后台同一张映射表，但**店面没有会话**，
 * 因此只能取部署缺省或单上游（按租户分流需要先知道租户，而店面路径里
 * 的 {tenant} 恰好可解析——这里保守地只用缺省，避免把 A 的请求发给 B）。
 */
function tenantIdForShop(env, upstream, upstreamMap) {
  const keys = Object.keys(upstreamMap || {});
  if (keys.length === 1) return upstreamMap[keys[0]];
  return String(env.ERP_API_UPSTREAM || upstream || "").replace(/\/+$/, "") || null;
}

// 租户标识的白名单，**必须与内核侧 `fd_erp_ledger_mcp/tenancy.py` 逐字一致**：
// `SLUG_PATTERN = ^[a-z0-9_]+$`、`MAX_SLUG_LEN = 32`、租户 0 的名字 `default`
// 映射到 `public`。两侧不一致的最坏形态不是报错，而是同一个标识在两侧被判成
// 不同租户（或一侧接受、另一侧拒绝），那才是隔离失效。
//
// 平台侧校验的目的是**把配置错误在本侧就判成配置错误**（400 invalid-tenant），
// 而不是让它作为 x-erp-tenant 头飘到上游、由一个业务语义完全不同的
// TENANT_DENIED / INVALID_ARGUMENT 冒出来。这不是内核白名单的替代品——
// 内核仍然自己校验（纵深防御，哪一侧被改坏都不能单独放行）。
export const TENANT_SLUG_PATTERN = /^[a-z0-9_]+$/;
export const TENANT_MAX_LEN = 32;
export const TENANT_DEFAULT = "default";

/** 租户标识是否为本侧与内核侧共同接受的形状。`false` 时调用方必须拒绝。 */
export function isValidTenantSlug(value) {
  if (typeof value !== "string") return false;
  const slug = value.trim();
  if (!slug) return false;
  if (slug === TENANT_DEFAULT) return true; // 租户 0：内核映射到 public
  return slug.length <= TENANT_MAX_LEN && TENANT_SLUG_PATTERN.test(slug);
}

// 客户端可自带、服务端必须重算的身份头（全部小写，Node 的 headers 是小写键）
const CLIENT_IDENTITY_HEADERS = [
  "x-erp-tenant",
  "x-erp-customer",
  "x-erp-staff",
  "x-erp-supplier",
  "x-erp-carrier",
  // 委托头（agent 自主下单的额度）：客户端自带的一律剥掉，只认服务端从
  // 已验签的 Grant 里解析出来的值。少了这两行，任何登录用户都能自称
  // 「预算 100 万」——闸就等于没有。
  "x-erp-grant-jti",
  "x-erp-grant-budget",
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
 * 读身份绑定表：{ "<email>": { tenant?, customer?, staff?, supplier?, carrier? } }。
 * 缺失/损坏 → 空表（fail-closed：谁都拿不到角色身份，服务侧如实 401/404）。
 *
 * `tenant` 与四个角色是**同一类事实**（这个会话是谁、属于谁），所以同表同源
 * （erp-tenant-from-session D1）。租户标识是**不带前缀的 slug**（`acme`），
 * schema 名（`tenant_acme`）由内核侧的 `schema_for` 派生——两侧对「标识」的取值
 * 必须同一个直觉，见该 change 的 design D5。
 */
export function loadIdentityBindings(filePath) {
  if (!filePath) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out = {};
    //: 保留一条绑定的判据是「tenant 或任一角色在场」。**不能只看角色**：
    //: 只绑租户不绑角色的条目（`{tenant:"acme"}`）此前会被整条丢弃，于是该会话
    //: 静默回落到部署缺省、拿到别人的租户（2026-11-17 实测发现）。
    const FIELDS = ["tenant", "customer", "staff", "supplier", "carrier"];
    for (const [email, roles] of Object.entries(raw)) {
      if (!roles || typeof roles !== "object" || Array.isArray(roles)) continue;
      const clean = {};
      for (const key of FIELDS) {
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
 * 一次请求该解析出哪个租户：绑定表 → 部署缺省 → `null`（调用方必须拒绝）。
 *
 * 三级顺序各自的作用：
 *   1. 绑定表 —— 让一套部署服务 N 个租户（多租户成立的唯一前提）
 *   2. 部署缺省 —— 让现有单租户部署**零行为变化**（绑定表没 `tenant` 字段时，
 *      解析结果恒等于 `ERP_TENANT_ID`，与本次变更前逐字节相同）
 *   3. `null` —— 让「配错了」表现为响亮的拒绝，而不是静默串租户
 *
 * 纯函数，便于单测六臂（见 tasks 1.2）。
 */
export function resolveTenant(email, bindings, deploymentTenantId) {
  const key = typeof email === "string" ? email.trim().toLowerCase() : "";
  const bound = key ? bindings?.[key]?.tenant : undefined;
  if (typeof bound === "string" && bound.trim()) return bound.trim();
  const fallback = typeof deploymentTenantId === "string" ? deploymentTenantId.trim() : "";
  return fallback || null;
}

/**
 * 一次请求该注入哪些身份头。
 *
 * - 租户：**按会话解析**（绑定表 → 部署缺省 `ERP_TENANT_ID` → 拒绝）。
 *   部署缺省只是兜底，不是真源——多租户共用一套部署时它必须让位于绑定表。
 * - SE 的 staff：会话账号本身（业务员就是登录人）——可用绑定表覆盖
 * - UE/SP/CP：只认绑定表（客户/供应商/承运商是**组织**，不是登录人，猜不得）
 *
 * 解析不出租户时**不注入** `x-erp-tenant`（而不是注入空值）——由调用方据此拒绝
 * （见 createErpProxy 里的 `tenant-unbound`）。
 */
export function resolveIdentityHeaders(
  user,
  { deploymentTenantId, bindings, defaultCustomer, grant = null },
) {
  const headers = {};
  const tenant = resolveTenant(user?.email, bindings, deploymentTenantId);
  if (tenant) headers["x-erp-tenant"] = tenant;
  // 委托（agent 代委托人）：`grant` 必须是**已验签**的 claims，不接受请求体里的
  // 自述字段。没有 Grant 时不注入——服务端那条路与改造前逐字节相同。
  if (grant && typeof grant === "object") {
    if (typeof grant.jti === "string" && grant.jti) headers["x-erp-grant-jti"] = grant.jti;
    const amount = grant?.budget?.amount;
    if (amount !== undefined && amount !== null && String(amount).trim()) {
      headers["x-erp-grant-budget"] = String(amount).trim();
    }
  }
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
 * 解析 `ERP_API_UPSTREAM_MAP`（JSON：租户标识 → 上游基址）。
 *
 * 非法 JSON / 非对象 → 空映射并 warn，**不抛错**：一张配错的映射表不该让整个
 * ERP 入口起不来。空映射的语义是「没配按租户分流」，回落到单上游，行为不变。
 */
export function parseUpstreamMap(raw, warn = () => {}) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warn(`[erp-proxy] ERP_API_UPSTREAM_MAP 不是合法 JSON（${err?.message || err}）；按未配置处理`);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn("[erp-proxy] ERP_API_UPSTREAM_MAP 必须是对象（租户标识 → 上游基址）；按未配置处理");
    return {};
  }
  const out = {};
  for (const [tenant, url] of Object.entries(parsed)) {
    if (typeof url === "string" && url.trim()) out[String(tenant).trim()] = url.trim();
    else warn(`[erp-proxy] ERP_API_UPSTREAM_MAP['${tenant}'] 不是非空字符串，已忽略`);
  }
  return out;
}

/**
 * 该租户该发往哪个上游：命中映射则用它，否则回落部署缺省，两者皆无返回 `null`。
 *
 * 返回 `null` 时调用方 MUST 拒绝（503），MUST NOT 回落到「别人的」上游——
 * 那会把 A 的请求发给 B 的实例，而上游的租户闸只会回一个语义完全不同的
 * `TENANT_DENIED`，把「这个租户没配上游」这件真事藏起来。
 */
export function upstreamFor(tenant, map = {}, fallback = "") {
  const key = typeof tenant === "string" ? tenant.trim() : "";
  const hit = key ? map?.[key] : undefined;
  if (typeof hit === "string" && hit.trim()) return hit.trim().replace(/\/+$/, "");
  const fb = typeof fallback === "string" ? fallback.trim() : "";
  return fb ? fb.replace(/\/+$/, "") : null;
}

/**
 * 构造代理中间件。挂在 app.use(ERP_PROXY_PREFIX, ...)，因此 req.url 只剩子路径。
 *
 * @param {object} opts
 * @param {string} [opts.upstream]   单上游基址（所有租户共用；缺省形态）
 * @param {function} [opts.upstreamFor] 按租户返回上游：`(tenant) => url | null`。
 *   与 `upstream` 互斥，同时给出时本函数优先（design D2：两个名字让调用点一眼
 *   看出走哪条路，不必猜一个参数的类型）。
 * @param {string} opts.tenantId    ERP_TENANT_ID（部署级缺省，不是真源）
 * @param {object} opts.bindings    会话邮箱 → 角色标识（见 loadIdentityBindings）
 * @param {string} [opts.defaultCustomer] 单客户部署的默认客户（演示形态；不设则不注入）
 * @param {boolean|function} opts.authEnabled 平台是否开启了会话鉴权
 * @param {number} [opts.timeoutMs]
 * @param {function} [opts.fetchImpl]
 */
export function createErpProxy(opts) {
  const {
    upstream,
    upstreamFor: upstreamResolver,
    tenantId = "",
    bindings = {},
    defaultCustomer = "",
    authEnabled = true,
    timeoutMs = 20_000,
    fetchImpl = globalThis.fetch,
    //: Grant 验签的 JWKS 地址（registry 的 /api/jwks）。为空 = 不做委托解析，
    //: 行为与改造前逐字节相同（这是默认，避免一次配置缺失就改变现有链路）。
    grantJwksUrl = "",
    //: 允许的 Grant audience。只有命中的票才被当成委托。
    grantAudiences = [],
  } = opts;

  const fixedBase = String(upstream || "").replace(/\/+$/, "");

  return async function erpProxy(req, res) {
    const isAuthOn = typeof authEnabled === "function" ? !!authEnabled() : !!authEnabled;
    // fail-closed：开启鉴权时没有会话一律 401（GET 也不会因为「非 /api 前缀算公开」
    // 而漏过——全局闸对 /erp 的 GET 是放行的，所以这一道必须在本文件里）。
    if (isAuthOn && !req.user?.email) {
      return unifiedError(res, 401, "AUTH_REQUIRED", "需要登录会话", "请先登录后再访问业务接口。");
    }

    // 1) 转发头：一律丢掉客户端自带的身份头与逐跳头
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const name = key.toLowerCase();
      if (CLIENT_IDENTITY_HEADERS.includes(name)) continue; // 剥离
      if (DROP_HEADERS.has(name)) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    // 1b) 委托：有 Bearer 且配了 JWKS 才尝试验签。验不过**静默降级为无委托**
    //    （不是 401）——店面允许匿名、ERP 后台的鉴权由下面的会话闸负责；这里只决定
    //    「要不要带上委托头」。带上伪造的头才是危险的，不带是安全的默认。
    let grant = null;
    if (grantJwksUrl) {
      const token = bearerFrom(req.headers.authorization);
      if (token) {
        grant = await verifyGrant(token, {
          jwksUrl: grantJwksUrl,
          fetchImpl,
          audiences: grantAudiences,
          warn: (m) => console.warn(m),
        });
      }
    }
    // 2) 服务端注入
    const injected = resolveIdentityHeaders(req.user, {
      deploymentTenantId: tenantId,
      bindings,
      defaultCustomer,
      grant,
    });
    // 2a) 租户是**必需的**上下文：解析不出就拒绝，不放行到上游。
    //   403 而不是 401：调用方身份有效，缺的是租户**归属**——这是授权问题不是认证
    //   问题。`tenant-unbound` 让客户端与运维一眼分辨「配错了」与「没登录」。
    //   无会话时上面已 401，所以这里只覆盖「有会话但绑不出来」。
    if (!injected["x-erp-tenant"]) {
      return unifiedError(
        res,
        403,
        "tenant-unbound",
        "该会话没有租户归属",
        "请让管理员把此邮箱绑到一个租户（ERP_IDENTITY_BINDINGS_FILE 的 tenant 字段），"
          + "或给部署设置 ERP_TENANT_ID 作为缺省。",
      );
    }
    // 2a-bis) 租户标识的形状必须两侧一致（6.1）。不在这里判，就会把「配置写错」
    //   伪装成上游的业务错误（TENANT_DENIED / INVALID_ARGUMENT），运维去查上游
    //   数据却查不出原因。400 而不是 403：这不是「没权限」，是「这个值不合法」。
    if (!isValidTenantSlug(injected["x-erp-tenant"])) {
      return unifiedError(
        res,
        400,
        "invalid-tenant",
        "租户标识不合法",
        `租户标识只允许小写字母、数字与下划线，长度 1-${TENANT_MAX_LEN}（或 ${TENANT_DEFAULT}）；`
          + "中文与连字符会被内核侧拒绝，请在绑定表或 ERP_TENANT_ID 里改正。",
      );
    }
    for (const [name, value] of Object.entries(injected)) headers[name] = value;

    // 2b) 选上游：用**同一个**租户变量（design D4 的不变量——头里写的租户与
    //   请求实际发往的实例必须是同一个租户）。没有对应上游就拒绝，绝不回落到
    //   别人的实例：那会让 A 的请求打到 B 的进程，而 B 的租户闸只会回一个语义
    //   完全不同的 TENANT_DENIED，把「这个租户没配上游」这件真事藏起来。
    const tenant = injected["x-erp-tenant"];
    const base = typeof upstreamResolver === "function"
      ? upstreamResolver(tenant)
      : fixedBase;
    if (!base) {
      return unifiedError(
        res,
        503,
        "UPSTREAM_NOT_CONFIGURED",
        `租户 ${tenant} 没有配置上游`,
        "部署侧需为该租户设置 ERP_API_UPSTREAM_MAP 条目，或设置 ERP_API_UPSTREAM 作缺省。",
      );
    }
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
  // 按租户分流（erp-tenant-upstream-routing）：配了映射表就用它，否则保持单上游。
  // 单上游路径与本次变更前**逐字节相同**——这是能安全上产的前提。
  const upstreamMap = parseUpstreamMap(env.ERP_API_UPSTREAM_MAP, (m) => console.warn(m));
  const hasMap = Object.keys(upstreamMap).length > 0;
  const bindingsPath =
    env.ERP_IDENTITY_BINDINGS_FILE || path.join(process.env.FD_DATA_DIR || "data", "erp-identities.json");

  if (typeof resolveUser === "function") {
    app.use(ERP_PROXY_PREFIX, (req, _res, next) => {
      const user = resolveUser(req);
      if (user) req.user = user;
      next();
    });
  }

  // 店面子代理自己的传输句柄：不依赖 createErpProxy 的闭包（那是另一个函数）。
  const shopFetch = ctx.fetchImpl ?? globalThis.fetch;
  const shopTimeoutMs = Number(env.ERP_SHOP_PROXY_TIMEOUT_MS) || 20_000;
  const grantJwksUrl = env.ERP_GRANT_JWKS_URL || "";
  const grantAudiences = String(env.ERP_GRANT_AUDIENCES || "erp-vertical-api")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  app.use(
    ERP_PROXY_PREFIX,
    createErpProxy({
      // 两条互斥的路，代码里一眼能看出走哪条（design D2）。
      ...(hasMap ? { upstreamFor: (tenant) => upstreamFor(tenant, upstreamMap, upstream) } : { upstream }),
      tenantId: env.ERP_TENANT_ID || "acme",
      bindings: loadIdentityBindings(bindingsPath),
      defaultCustomer: env.ERP_DEFAULT_CUSTOMER || "",
      // 鉴权开关按请求读：与 boards.js 同一约定，改 env 不必重启
      authEnabled: () => ctx.authEnabled !== false,
      grantJwksUrl,
      grantAudiences,
    }),
  );

  // ── 店面（/shop/*）同源反代 ─────────────────────────────────────────────
  //
  // 店面与 ERP 后台**身份模型不同**：店面匿名可读、可匿名下单（买家没有账号），
  // 到账登记才要商家身份。所以它不能复用上面的 fail-closed 闸。
  //
  // 委托头只在这里注入（agent 用 Grant 下单）：
  //   有 Bearer + JWKS 配好 → 验签 → 注入 x-erp-grant-*；验不过就**不注入**
  //   （调用方拿不到额度，服务端按「人」处理），而不是 401——匿名店面对访客
  //   本来就不该要求票。
  // 客户端自带的 x-erp-* 头一律剥掉（同 ERP 后台的纪律）。
  app.use(SHOP_PROXY_PREFIX, async (req, res) => {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const name = key.toLowerCase();
      if (CLIENT_IDENTITY_HEADERS.includes(name)) continue;
      if (DROP_HEADERS.has(name)) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    let grant = null;
    if (grantJwksUrl) {
      const token = bearerFrom(req.headers.authorization);
      if (token) {
        grant = await verifyGrant(token, {
          jwksUrl: grantJwksUrl,
          fetchImpl: shopFetch,
          audiences: grantAudiences,
          warn: (m) => console.warn(m),
        });
      }
    }
    if (grant) {
      if (typeof grant.jti === "string" && grant.jti) headers["x-erp-grant-jti"] = grant.jti;
      const amount = grant?.budget?.amount;
      if (amount !== undefined && amount !== null && String(amount).trim()) {
        headers["x-erp-grant-budget"] = String(amount).trim();
      }
    }

    const base = tenantIdForShop(env, upstream, upstreamMap);
    if (!base) {
      return unifiedError(res, 503, "shop-upstream-unbound", "店面上游未配置",
        "设置 ERP_API_UPSTREAM 或 ERP_API_UPSTREAM_MAP。");
    }
    const target = base.replace(/\/+$/, "") + req.originalUrl;
    try {
      const upstreamRes = await shopFetch(target, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : req,
        duplex: ["GET", "HEAD"].includes(req.method) ? undefined : "half",
        signal: AbortSignal.timeout(shopTimeoutMs),
        redirect: "manual",
      });
      res.status(upstreamRes.status);
      for (const [k, v] of upstreamRes.headers) {
        if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) continue;
        res.setHeader(k, v);
      }
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      res.end(buf);
    } catch (err) {
      console.warn(`[erp-shop-proxy] ${req.method} ${req.originalUrl} 失败：${err?.message || err}`);
      return unifiedError(res, 502, "UPSTREAM_UNAVAILABLE", "店面上游不可达", "请稍后重试。");
    }
  });
}

export { IDENTITY_BY_PAGESET };
//: 仅供测试断言「委托头在可伪造清单里」。生产代码请用内部常量。
export const CLIENT_IDENTITY_HEADERS_FOR_TEST = CLIENT_IDENTITY_HEADERS;
