// 交易委托桥：额度上限只能是「配置与请求的较小者」，且只为一个 aud 出票。
//
// 这条路由是「agent 能花钱」的唯一授权点，所以它的判据必须是最紧的那一档：
// 一旦它能被用来签发别的服务、或抬到超过运维设定，整条预算闸就等于没有。

import test from "node:test";
import assert from "node:assert/strict";

import { pickLower, registerTradeGrantRoute } from "./trade-grant.js";

test("pickLower 取较小者", () => {
  assert.equal(pickLower("500", "100"), "100");
  assert.equal(pickLower("100", "500"), "100");
  assert.equal(pickLower("500", ""), "500");
  assert.equal(pickLower("", "50"), "50");
  assert.equal(pickLower("", ""), "");
});

test("pickLower 忽略非法值而不是当成 0 或无限", () => {
  assert.equal(pickLower("abc", "100"), "100");
  assert.equal(pickLower("-5", "100"), "100");
  assert.equal(pickLower("500", "abc"), "500");
});

function makeApp() {
  const routes = [];
  return {
    app: { post: (path, h) => routes.push({ path, h }) },
    routes,
  };
}

function makeRes() {
  const out = { status: 200, body: undefined, headers: {} };
  return {
    out,
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
    setHeader(k, v) { out.headers[k] = v; return this; },
  };
}

function bodyReq(body) { return { body, socket: { remoteAddress: "127.0.0.1" } }; }

const ENV = {
  MARKET_REGISTRY_URL: "https://registry.test",
  GRANT_ISSUER_TOKEN: "tok-1",
  ERP_TRADE_GRANT_BUDGET: "500",
  ERP_TRADE_AGENT_SUB: "agent:procurement-acme",
  ERP_TENANT_ID: "acme",
};

test("未配置 registry 时 ships-dark，不伪造票", async () => {
  const { app, routes } = makeApp();
  registerTradeGrantRoute({ app, env: {} });
  const res = makeRes();
  await routes[0].h(bodyReq({ act: "a@b", run: "r1" }), res);
  assert.equal(res.out.status, 503);
  assert.equal(res.out.body.error, "trade_grant_unconfigured");
});

test("缺 act 或 run 直接 400", async () => {
  const { app, routes } = makeApp();
  registerTradeGrantRoute({ app, env: ENV, fetchImpl: async () => ({ ok: true, json: async () => ({ token: "t" }) }) });
  const res = makeRes();
  await routes[0].h(bodyReq({ act: "a@b" }), res);
  assert.equal(res.out.status, 400);
});

test("只为一个 aud 出票，且 act 原样传给 registry", async () => {
  let sent;
  const { app, routes } = makeApp();
  registerTradeGrantRoute({
    app, env: ENV,
    fetchImpl: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ token: "grant-1", aud: "erp-vertical-api", exp: 1 }) };
    },
  });
  const res = makeRes();
  await routes[0].h(bodyReq({ act: "aloadtree@gmail.com", run: "r1", budget: "100" }), res);
  assert.equal(sent.url, "https://registry.test/api/grants");
  assert.equal(sent.body.aud, "erp-vertical-api");
  assert.equal(sent.body.act, "aloadtree@gmail.com");
  assert.equal(sent.body.sub, "agent:procurement-acme");
  assert.equal(sent.body.tenant, "acme");
  // 请求的 100 低于配置的 500 ⇒ 用 100
  assert.equal(sent.body.budget.amount, "100");
  assert.equal(res.out.status, 200);
  assert.equal(res.out.body.token, "grant-1");
});

test("请求想抬高额度时被配置上限压住", async () => {
  let sent;
  const { app, routes } = makeApp();
  registerTradeGrantRoute({
    app, env: ENV,
    fetchImpl: async (_u, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ token: "g", aud: "erp-vertical-api", exp: 1 }) };
    },
  });
  await routes[0].h(bodyReq({ act: "a@b", run: "r1", budget: "999999" }), makeRes());
  assert.equal(sent.budget.amount, "500");
});

test("registry 401 被翻译成 403（授权问题不是服务故障）", async () => {
  const { app, routes } = makeApp();
  registerTradeGrantRoute({
    app, env: ENV,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ detail: "Authentication required" }) }),
  });
  const res = makeRes();
  await routes[0].h(bodyReq({ act: "a@b", run: "r1" }), res);
  assert.equal(res.out.status, 403);
  assert.equal(res.out.body.error, "grant_refused");
});

test("registry 不可达是 502，不伪装成拒绝", async () => {
  const { app, routes } = makeApp();
  registerTradeGrantRoute({
    app, env: ENV,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  const res = makeRes();
  await routes[0].h(bodyReq({ act: "a@b", run: "r1" }), res);
  assert.equal(res.out.status, 502);
  assert.equal(res.out.body.error, "grant_unreachable");
});

test("registry 返回无 token 时不透出成功", async () => {
  const { app, routes } = makeApp();
  registerTradeGrantRoute({
    app, env: ENV,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ aud: "erp-vertical-api" }) }),
  });
  const res = makeRes();
  await routes[0].h(bodyReq({ act: "a@b", run: "r1" }), res);
  assert.notEqual(res.out.status, 200);
  assert.equal(res.out.body.token, undefined);
});

test("GRANT_ISSUER_TOKEN 优先于 AGENT_SERVING_REGISTRY_TOKEN", async () => {
  let used;
  const { app, routes } = makeApp();
  registerTradeGrantRoute({
    app,
    env: { ...ENV, GRANT_ISSUER_TOKEN: "issuer-key", AGENT_SERVING_REGISTRY_TOKEN: "serving-key" },
    fetchImpl: async (_u, init) => {
      used = init.headers.authorization;
      return { ok: true, json: async () => ({ token: "t", aud: "erp-vertical-api", exp: 1 }) };
    },
  });
  await routes[0].h(bodyReq({ act: "a@b", run: "r1" }), makeRes());
  assert.equal(used, "Bearer issuer-key");
});

test("非 loopback 来源被拒（豁免会话闸后必须自带门）", async () => {
  const { app, routes } = makeApp();
  registerTradeGrantRoute({
    app, env: ENV,
    fetchImpl: async () => { throw new Error("should not reach registry"); },
  });
  const res = makeRes();
  await routes[0].h(
    { body: { act: "a@b", run: "r1" }, socket: { remoteAddress: "203.0.113.9" } },
    res,
  );
  assert.equal(res.out.status, 403);
  assert.equal(res.out.body.error, "loopback_only");
});
