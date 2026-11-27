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

import { ERP_PROXY_PREFIX, SHOP_PROXY_PREFIX, createErpProxy, isValidTenantSlug, loadIdentityBindings, parseUpstreamMap, registerErpProxyRoutes, resolveIdentityHeaders, resolveTenant, upstreamFor } from "../server/routes/erp-proxy.js";

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
    { deploymentTenantId: "acme", bindings, defaultCustomer: "" },
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
    { deploymentTenantId: "acme", bindings: {}, defaultCustomer: "" },
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
  // 2026-11-25 起多挂 /shop：店面匿名面与 ERP 后台身份模型不同，必须分开挂载
  // （establish-ai-native-ecommerce-stack 4.1）。关掉开关时两者都不挂。
  assert.deepEqual(mounted, [ERP_PROXY_PREFIX, SHOP_PROXY_PREFIX]);
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



// ── 租户从会话解析（openspec: erp-tenant-from-session） ──────────────────────

test("resolveTenant: 绑定表 > 部署缺省 > null（三级顺序）", () => {
  assert.equal(resolveTenant("a@x.com", { "a@x.com": { tenant: "acme" } }, "fallback"), "acme",
    "绑定表优先于部署缺省");
  assert.equal(resolveTenant("b@x.com", {}, "fallback"), "fallback",
    "无绑定时回落缺省（单租户部署零行为变化）");
  assert.equal(resolveTenant("b@x.com", {}, ""), null, "两者皆无 ⇒ null（调用方须拒绝）");
  assert.equal(resolveTenant(null, {}, "fallback"), "fallback", "无会话仍可回落缺省");
});

test("resolveTenant: 邮箱归一化与空白容错", () => {
  const bindings = { "a@x.com": { tenant: "acme" } };
  assert.equal(resolveTenant("  A@X.COM  ", bindings, ""), "acme", "大小写与空格不敏感");
  assert.equal(resolveTenant("a@x.com", { "a@x.com": { tenant: "  acme  " } }, ""), "acme",
    "绑定值两侧空白被裁掉");
  assert.equal(resolveTenant("a@x.com", { "a@x.com": { tenant: "   " } }, "fb"), "fb",
    "空白租户视为未绑定");
});

test("loadIdentityBindings: 只绑租户不绑角色的条目必须保留", async () => {
  // 这条钉住 2026-11-17 实测的 bug：判据曾只看四个角色字段，于是
  // {"tenant":"acme"} 被整条丢弃 → 该会话静默回落部署缺省、拿到别人的租户。
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "erp-tenant-only-"));
  const file = join(dir, "erp-identities.json");
  writeFileSync(file, JSON.stringify({ "a@x.com": { tenant: "acme" } }));
  assert.deepEqual(loadIdentityBindings(file)["a@x.com"], { tenant: "acme" },
    "只绑租户的条目被丢了");
});

test("两个会话得到不同租户", () => {
  const bindings = { "a@x.com": { tenant: "a" }, "b@x.com": { tenant: "b" } };
  const spec = { deploymentTenantId: "", bindings, defaultCustomer: "" };
  assert.equal(resolveIdentityHeaders({ email: "a@x.com" }, spec)["x-erp-tenant"], "a");
  assert.equal(resolveIdentityHeaders({ email: "b@x.com" }, spec)["x-erp-tenant"], "b");
});

test("端到端：有会话但无租户归属 ⇒ 403 tenant-unbound，且不转发", async () => {
  let hit = false;
  const upstream = http.createServer((_req, res) => {
    hit = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const app = express();
  app.use((req, _res, next) => { req.user = { email: "nobody@x.com" }; next(); });
  app.use(
    ERP_PROXY_PREFIX,
    createErpProxy({
      upstream: `http://127.0.0.1:${upstream.address().port}`,
      tenantId: "",          // 部署缺省为空
      bindings: {},          // 该会话也没绑定
      defaultCustomer: "",
      authEnabled: true,
      fetchImpl: fetch,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ERP_PROXY_PREFIX}/pagesets`);
    assert.equal(res.status, 403, "无租户归属必须拒绝");
    assert.equal((await res.json()).error.code, "tenant-unbound");
    assert.equal(hit, false, "被拒的请求 MUST NOT 转发到上游");
  } finally {
    server.close();
    upstream.close();
  }
});

// ── 按租户选上游（openspec: erp-tenant-upstream-routing） ────────────────────

test("parseUpstreamMap: 非法输入降级为空映射，不抛错", () => {
  const warn = () => {};
  assert.deepEqual(parseUpstreamMap('{"a":"http://x:1"}', warn), { a: "http://x:1" });
  assert.deepEqual(parseUpstreamMap("", warn), {});
  assert.deepEqual(parseUpstreamMap("{ not json", warn), {}, "非法 JSON 不能让入口起不来");
  assert.deepEqual(parseUpstreamMap("[1,2]", warn), {}, "数组不是映射表");
  assert.deepEqual(parseUpstreamMap('{"a":42}', warn), {}, "值非字符串被忽略");
});

test("upstreamFor: 命中 > 回落 > null", () => {
  const map = { a: "http://ua:1", b: "http://ub:1/" };
  assert.equal(upstreamFor("a", map, "http://fallback:1"), "http://ua:1");
  assert.equal(upstreamFor("b", map, ""), "http://ub:1", "尾斜杠被裁掉");
  assert.equal(upstreamFor("c", map, "http://fallback:1"), "http://fallback:1", "未命中回落缺省");
  assert.equal(upstreamFor("c", map, ""), null, "两者皆无 ⇒ null（调用方须拒绝）");
  assert.equal(upstreamFor(null, map, "http://fb:1"), "http://fb:1");
});

test("端到端：两个租户各发各的上游，互不串", async () => {
  const mk = () => {
    const box = { hits: 0, tenants: [] };
    const srv = http.createServer((req, res) => {
      box.hits += 1;
      box.tenants.push(req.headers["x-erp-tenant"]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ from: box.hits }));
    });
    return { srv, box };
  };
  const A = mk();
  const B = mk();
  await new Promise((r) => A.srv.listen(0, "127.0.0.1", r));
  await new Promise((r) => B.srv.listen(0, "127.0.0.1", r));
  const upstreamMap = {
    a: `http://127.0.0.1:${A.srv.address().port}`,
    b: `http://127.0.0.1:${B.srv.address().port}`,
  };
  const bindings = { "a@x.com": { tenant: "a" }, "b@x.com": { tenant: "b" } };
  const app = express();
  app.use((req, _res, next) => {
    req.user = { email: req.headers["x-test-who"] };
    next();
  });
  app.use(
    ERP_PROXY_PREFIX,
    createErpProxy({
      upstreamFor: (t) => upstreamFor(t, upstreamMap, ""),
      tenantId: "",
      bindings,
      defaultCustomer: "",
      authEnabled: true,
      fetchImpl: fetch,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}${ERP_PROXY_PREFIX}/pagesets`;
  try {
    await fetch(base, { headers: { "x-test-who": "a@x.com" } });
    await fetch(base, { headers: { "x-test-who": "b@x.com" } });
    assert.equal(A.box.hits, 1, "a 的上游只该收到 1 次");
    assert.equal(B.box.hits, 1, "b 的上游只该收到 1 次");
    assert.deepEqual(A.box.tenants, ["a"], "a 的实例只该看到租户 a");
    assert.deepEqual(B.box.tenants, ["b"], "b 的实例只该看到租户 b");
  } finally {
    server.close();
    A.srv.close();
    B.srv.close();
  }
});

test("端到端：该租户没配上游 ⇒ 503 且不转发任何实例", async () => {
  let hits = 0;
  const other = http.createServer((_req, res) => { hits += 1; res.end("{}"); });
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  const app = express();
  app.use((req, _res, next) => { req.user = { email: "lonely@x.com" }; next(); });
  app.use(
    ERP_PROXY_PREFIX,
    createErpProxy({
      // 映射表里只有 a，没有 lonely 的租户；也没有缺省
      upstreamFor: (t) => upstreamFor(t, { a: `http://127.0.0.1:${other.address().port}` }, ""),
      tenantId: "",
      bindings: { "lonely@x.com": { tenant: "unmapped" } },
      defaultCustomer: "",
      authEnabled: true,
      fetchImpl: fetch,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ERP_PROXY_PREFIX}/pagesets`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, "UPSTREAM_NOT_CONFIGURED");
    assert.match(body.error.message, /unmapped/, "必须点名是哪个租户没配上游");
    assert.equal(hits, 0, "MUST NOT 借用别的租户的上游");
  } finally {
    server.close();
    other.close();
  }
});

test("顺序：无租户归属（403）先于无上游（503）", async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = { email: "nobody@x.com" }; next(); });
  app.use(
    ERP_PROXY_PREFIX,
    createErpProxy({
      upstreamFor: () => null,   // 上游也没有
      tenantId: "",
      bindings: {},
      defaultCustomer: "",
      authEnabled: true,
      fetchImpl: fetch,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ERP_PROXY_PREFIX}/pagesets`);
    assert.equal(res.status, 403, "没有租户就谈不上该租户的上游");
    assert.equal((await res.json()).error.code, "tenant-unbound");
  } finally {
    server.close();
  }
});

// ── 6.1 租户标识白名单：与内核侧共用同一份判据文件 ────────────────────────
// 两侧各自读 contracts/erp-tenant-slug-cases.json，断言自己在同一组值上给出
// 与 accept 相同的判定。任何一侧改了白名单而没改另一侧，这里就红。
test("6.1 租户标识白名单逐值正确（契约清单在仓内）", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  // 清单在本仓内：CI 只 checkout 本仓，读不到内核仓的文件。
  // 与内核侧「同一组值」由工作区脚本 scripts/check_erp_tenant_slug_contract.py 核对。
  const contractPath = join(here, "erp-tenant-slug-cases.json");
  const { cases } = JSON.parse(readFileSync(contractPath, "utf8"));
  assert.ok(cases.length > 0, "契约文件不能是空的（空集合会让本断言无条件通过）");
  const wrong = [];
  for (const c of cases) {
    const got = isValidTenantSlug(c.value);
    if (got !== c.accept) wrong.push(`${JSON.stringify(c.value)} 期望 ${c.accept} 实际 ${got}（${c.why}）`);
  }
  assert.deepEqual(wrong, [], "平台侧与内核侧对租户标识的判定不一致");
});

test("6.1 非法租户不进上游：400 invalid-tenant，且上游一次都没被调用", async () => {
  let hit = false;
  const app = express();
  app.use((req, _res, next) => { req.user = { email: "a@x.com" }; next(); });
  app.use(
    ERP_PROXY_PREFIX,
    createErpProxy({
      upstream: "http://127.0.0.1:1/never",
      tenantId: "acme",
      bindings: { "a@x.com": { tenant: "百度" } },  // 中文：配置写错
      defaultCustomer: "",
      authEnabled: true,
      fetchImpl: () => { hit = true; throw new Error("不该被调用"); },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ERP_PROXY_PREFIX}/pagesets`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid-tenant");
    assert.equal(hit, false, "配置错误不能变成一次上游调用");
  } finally {
    server.close();
  }
});

test("6.1 缺省值 default 是合法租户（内核映射到 public）", async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = { email: "a@x.com" }; next(); });
  app.use(
    ERP_PROXY_PREFIX,
    createErpProxy({
      upstream: upstreamBase,
      tenantId: "default",
      bindings: {},
      defaultCustomer: "",
      authEnabled: true,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${ERP_PROXY_PREFIX}/pagesets`);
    assert.equal(res.status, 200);
    const { seen } = await res.json();
    assert.equal(seen.headers["x-erp-tenant"], "default");
  } finally {
    server.close();
  }
});
