// ERP 同源代理单测（add-erp-supply-chain-gateway-proxy 3.1）
//
// 锁死三件事（这是唯一一条「客户端头不可信」的安全缝）：
//   1. 客户端自带的 X-ERP-* 一律剥离，不转发给上游；
//   2. 服务端按会话重新注入（租户常量 + 绑定表角色）；
//   3. 无会话 401，不匿名兜底。
//
// 跑法：node --test scripts/test-erp-proxy.mjs（或 npm run test:unit）

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

import express from "express";

import {
  ERP_PROXY_PREFIX,
  createErpProxy,
  loadIdentityBindings,
  registerErpProxyRoutes,
  resolveIdentityHeaders,
} from "../server/routes/erp-proxy.js";

// ── 假上游：把收到的请求原样回显（method/path/headers/body） ───────────────
let upstream;
let upstreamBase;
let lastSeen;

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastSeen = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, seen: lastSeen }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
});

after(() => upstream.close());

// 起一个「挂好代理」的 app；setUser 决定本请求的会话身份
async function startApp({ setUser = null, authEnabled = true, bindings = {}, defaultCustomer = "" } = {}) {
  const app = express();
  app.use((req, _res, next) => {
    const user = setUser ? setUser(req) : null;
    if (user) req.user = user;
    next();
  });
  app.use(
    ERP_PROXY_PREFIX,
    createErpProxy({
      upstream: upstreamBase,
      tenantId: "acme",
      bindings,
      defaultCustomer,
      authEnabled,
      timeoutMs: 5_000,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("无会话 → 401 AUTH_REQUIRED（GET 也不能漏）", async () => {
  const { server, base } = await startApp({ setUser: null });
  try {
    const res = await fetch(`${base}${ERP_PROXY_PREFIX}/pagesets`, {
      headers: { "x-erp-tenant": "acme" }, // 客户端自带也不该被采信
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "AUTH_REQUIRED");
  } finally {
    server.close();
  }
});

test("客户端伪造 X-ERP-Supplier 被剥离，租户由服务端注入", async () => {
  const { server, base } = await startApp({ setUser: () => ({ email: "alice@example.com" }) });
  try {
    const res = await fetch(`${base}${ERP_PROXY_PREFIX}/pagesets`, {
      headers: {
        "x-erp-supplier": "evil-supplier", // 必须消失
        "x-erp-carrier": "evil-carrier",
        "x-erp-customer": "evil-customer",
        "x-erp-tenant": "other-tenant", // 必须被覆盖成部署租户
      },
    });
    assert.equal(res.status, 200);
    const { seen } = await res.json();
    assert.equal(seen.headers["x-erp-supplier"], undefined);
    assert.equal(seen.headers["x-erp-carrier"], undefined);
    assert.equal(seen.headers["x-erp-customer"], undefined);
    assert.equal(seen.headers["x-erp-tenant"], "acme");
    // SE 的 staff 取会话账号（业务员就是登录人）
    assert.equal(seen.headers["x-erp-staff"], "alice@example.com");
  } finally {
    server.close();
  }
});

test("绑定表里的角色由服务端注入（邮箱大小写不敏感）", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "erp-bind-"));
  const file = join(dir, "erp-identities.json");
  writeFileSync(
    file,
    JSON.stringify({ "Bob@Example.com": { supplier: "SUP-001", customer: "CUST-9", staff: "STAFF-7" } }),
  );
  const bindings = loadIdentityBindings(file);
  const resolved = resolveIdentityHeaders(
    { email: "bob@example.com" },
    { tenantId: "acme", bindings, defaultCustomer: "" },
  );
  assert.equal(resolved["x-erp-supplier"], "SUP-001");
  assert.equal(resolved["x-erp-customer"], "CUST-9");
  assert.equal(resolved["x-erp-staff"], "STAFF-7");
  assert.equal(resolved["x-erp-tenant"], "acme");
});

test("绑定表缺失/损坏 → 空表（fail-closed）", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "erp-bind-bad-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  assert.deepEqual(loadIdentityBindings(join(dir, "missing.json")), {});
  assert.deepEqual(loadIdentityBindings(bad), {});
  assert.deepEqual(loadIdentityBindings(""), {});
});

test("未绑定角色 = 不注入（服务侧如实 401/404，不猜身份）", async () => {
  const resolved = resolveIdentityHeaders(
    { email: "nobody@example.com" },
    { tenantId: "acme", bindings: {}, defaultCustomer: "" },
  );
  assert.equal(resolved["x-erp-supplier"], undefined);
  assert.equal(resolved["x-erp-customer"], undefined);
  assert.equal(resolved["x-erp-carrier"], undefined);
  assert.equal(resolved["x-erp-staff"], "nobody@example.com");
});

test("POST 原始字节转发 + 全前缀路径不重写", async () => {
  const { server, base } = await startApp({ setUser: () => ({ email: "alice@example.com" }) });
  try {
    const payload = '{"sku":"A-1","qty":2,"note":"原样：空格 与中文"}';
    const res = await fetch(`${base}${ERP_PROXY_PREFIX}/ue/cart/lines?x=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    assert.equal(res.status, 200);
    const { seen } = await res.json();
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, `${ERP_PROXY_PREFIX}/ue/cart/lines?x=1`);
    assert.equal(seen.body, payload);
  } finally {
    server.close();
  }
});

test("鉴权关闭时不拦（自托管单进程形态）", async () => {
  const { server, base } = await startApp({ setUser: null, authEnabled: false });
  try {
    const res = await fetch(`${base}${ERP_PROXY_PREFIX}/pagesets`);
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test("上游不可达 → 502 UPSTREAM_UNREACHABLE（统一壳）", async () => {
  const app = express();
  app.use(
    ERP_PROXY_PREFIX,
    createErpProxy({
      upstream: "http://127.0.0.1:1",
      tenantId: "acme",
      authEnabled: false,
      timeoutMs: 2_000,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ERP_PROXY_PREFIX}/pagesets`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, "UPSTREAM_UNREACHABLE");
  } finally {
    server.close();
  }
});

test("registerErpProxyRoutes 可被 ERP_API_PROXY_ENABLED=0 关掉", () => {
  const mounted = [];
  const app = { use: (p) => mounted.push(p) };
  registerErpProxyRoutes({ app, env: { ERP_API_PROXY_ENABLED: "0" }, authEnabled: true });
  assert.deepEqual(mounted, []);
  registerErpProxyRoutes({ app, env: {}, authEnabled: true });
  assert.deepEqual(mounted, [ERP_PROXY_PREFIX]);
});

test("网关形态：resolveUser 落成 req.user 后才算有会话（3100 由 gateway 持有）", async () => {
  // 产上 origin 端口不是 server.js，而是 `node gateway/index.js`；网关的会话只
  // 在路由里解，所以 registerErpProxyRoutes 必须接受 resolveUser 并先落成
  // req.user。缺了这一钩子，带 cookie 的用户也会被判成无会话（401）。
  const mkApp = (resolveUser) => {
    const app = express();
    registerErpProxyRoutes({
      app,
      resolveUser,
      env: { ERP_API_UPSTREAM: upstreamBase, ERP_TENANT_ID: "acme" },
    });
    // 网关的 SPA 兜底在下游：这里照抄一条，证明代理已经先一步接住 /erp/*
    app.get(/^\/(?!api\/).*/, (_req, res) => res.type("html").send("<!doctype html>"));
    return app;
  };

  const authed = mkApp(() => ({ email: "Gw@Example.com" }));
  const server = authed.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ERP_PROXY_PREFIX}/pagesets`, {
      headers: { "x-erp-supplier": "evil-supplier" },
    });
    assert.equal(res.status, 200, "有会话时不能被 SPA 兜底抢走");
    const { seen } = await res.json();
    assert.equal(seen.headers["x-erp-staff"], "Gw@Example.com");
    assert.equal(seen.headers["x-erp-supplier"], undefined);
    assert.equal(seen.headers["x-erp-tenant"], "acme");
  } finally {
    server.close();
  }

  const anonymous = mkApp(() => null);
  const server2 = anonymous.listen(0, "127.0.0.1");
  await new Promise((r) => server2.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server2.address().port}${ERP_PROXY_PREFIX}/pagesets`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "AUTH_REQUIRED");
  } finally {
    server2.close();
  }
});
