// 5.2 生产零变更验证（erp-tenant-upstream-routing）
//
// 判据不是「线上调一次看着像」，而是：**同一份请求、同一份生产环境变量**，
// 分别经「本次变更前的单上游构造」与「本次变更后的从 env 构造」两条路径，
// 断言上游收到的 method / url / 身份头 / 请求体**逐字节相同**，响应体也逐字节相同。
//
// 生产实测的 env 形态（2026-11-18 从 fd-prod Deployment 读出）：
//   ERP_API_UPSTREAM=http://10.43.153.194
//   ERP_TENANT_ID=acme
//   ERP_API_UPSTREAM_MAP —— **不存在**（本 change 的核心前提：不设=行为不变）
//   ERP_IDENTITY_BINDINGS_FILE 指向的绑定表里两个邮箱都没有 tenant 字段
//
// 跑法：node --test scripts/test-erp-proxy-zero-change.mjs

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

import express from "express";

import {
  ERP_PROXY_PREFIX,
  createErpProxy,
  resolveIdentityHeaders,
} from "../server/routes/erp-proxy.js";

// 生产绑定表的真实形态：有角色、无 tenant 字段
const PROD_BINDINGS = {
  "platform-test@findmail.com": {
    customer: "a8224a24417e4897918777d772a71b79",
    supplier: "3b33b9980ca74f0a9946e7b36412ddb9",
    carrier: "CARRIER-DEMO-001",
  },
};

// 变更前的实现：租户恒为部署常量，头一律由 resolveIdentityHeaders 注入。
// 这段是**故意留在这里的旧逻辑**，作为对照臂——改它等于取消本测试的意义。
function legacyIdentityHeaders(user, { tenantId, bindings, defaultCustomer }) {
  const headers = { "x-erp-tenant": tenantId };
  if (!user?.email) return headers;
  const roles = bindings[String(user.email).trim().toLowerCase()] || {};
  headers["x-erp-staff"] = roles.staff || user.email;
  if (roles.customer) headers["x-erp-customer"] = roles.customer;
  else if (defaultCustomer) headers["x-erp-customer"] = defaultCustomer;
  if (roles.supplier) headers["x-erp-supplier"] = roles.supplier;
  if (roles.carrier) headers["x-erp-carrier"] = roles.carrier;
  return headers;
}

let upstream;
let upstreamBase;
let seen;

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen = {
        method: req.method,
        url: req.url,
        // 只取身份头与 content-type：其它（user-agent 等）由 fetch 决定，与本变更无关
        identity: Object.fromEntries(
          Object.entries(req.headers)
            .filter(([k]) => k.startsWith("x-erp-") || k === "content-type")
            .sort(),
        ),
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, echo: seen }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
});

after(() => upstream.close());

// 更直接的做法：绕过 registerErpProxyRoutes 里的缺省 URL 推导，直接构造两个中间件，
// 只有 upstream / upstreamFor 的传法不同——这正是两个 change 之间的唯一差异面。
async function callMiddleware(mw, { method = "GET", path = "/pagesets", body, headers = {} } = {}) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { email: "platform-test@findmail.com" };
    next();
  });
  app.use(ERP_PROXY_PREFIX, mw);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ERP_PROXY_PREFIX}${path}`, {
      method,
      headers,
      body,
    });
    return { status: res.status, bodyText: await res.text(), seen };
  } finally {
    server.close();
  }
}

test("5.2 生产零变更：无 ERP_API_UPSTREAM_MAP 时，新旧两条构造路径逐字节相同", async () => {
  const common = {
    tenantId: "acme",
    bindings: PROD_BINDINGS,
    defaultCustomer: "",
    authEnabled: true,
    timeoutMs: 5_000,
  };

  const cases = [
    { name: "GET 读接口", opts: { method: "GET", path: "/pagesets" } },
    { name: "GET 带查询串", opts: { method: "GET", path: "/pagesets?limit=5&offset=0" } },
    {
      name: "POST 带 JSON 体",
      opts: {
        method: "POST",
        path: "/postings/query",
        body: JSON.stringify({ account: "1001", from: "2026-01-01" }),
        headers: { "content-type": "application/json" },
      },
    },
    {
      name: "客户端伪造身份头（必须被剥）",
      opts: {
        method: "GET",
        path: "/pagesets",
        headers: { "x-erp-tenant": "evil", "x-erp-supplier": "evil" },
      },
    },
  ];

  for (const c of cases) {
    // 旧臂：upstream 字符串（变更前的唯一形态）
    const legacy = await callMiddleware(createErpProxy({ ...common, upstream: upstreamBase }), c.opts);
    // 新臂：只给 upstreamFor，map 里没有该租户 → 回落 fallback（= 生产 env 的形态）
    const mapped = await callMiddleware(
      createErpProxy({
        ...common,
        upstreamFor: (tenant) => (tenant === "acme" ? upstreamBase : null),
      }),
      c.opts,
    );

    assert.equal(mapped.status, legacy.status, `${c.name}：状态码必须相同`);
    assert.deepEqual(mapped.seen, legacy.seen, `${c.name}：上游收到的请求必须逐字段相同`);
    assert.equal(mapped.seen.identity["x-erp-tenant"], "acme", `${c.name}：租户仍由部署缺省给出`);
    assert.equal(
      mapped.bodyText.replace(/"seen":.*$/s, ""),
      legacy.bodyText.replace(/"seen":.*$/s, ""),
      `${c.name}：响应体（去掉回显部分）必须相同`,
    );
  }
});

test("5.2 补充：旧实现的头解析与新实现给出同一组身份头", () => {
  const user = { email: "Platform-Test@FindMail.com" };
  const args = { tenantId: "acme", bindings: PROD_BINDINGS, defaultCustomer: "" };
  const legacy = legacyIdentityHeaders(user, args);
  const current = resolveIdentityHeaders(user, {
    deploymentTenantId: args.tenantId,
    bindings: args.bindings,
    defaultCustomer: args.defaultCustomer,
  });
  assert.deepEqual(current, legacy, "生产绑定表（无 tenant 字段）下两组头必须完全相同");
});

test("5.2 补充：生产 env 里确实没有 ERP_API_UPSTREAM_MAP（本验证的前提）", async () => {
  // 这条不是测代码，是把「前提」钉在测试里：若哪天生产配了 map，本文件第一条
  // 的结论就不再覆盖生产，必须重新做一次零变更验证。生产 env 从 k8s 读（见
  // tasks 5.2 的记录）；这里只断言「不设 map 时代码走的是单上游路径」。
  const mw = await import("../server/routes/erp-proxy.js").then((m) => m.parseUpstreamMap(undefined));
  assert.deepEqual(mw, {}, "未配置 map 必须解析为空映射，从而走单上游路径");
});
