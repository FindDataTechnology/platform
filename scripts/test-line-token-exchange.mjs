#!/usr/bin/env node
// ── 门 K 换票测试（change converge-line-identity-and-keys，任务 7.1）─────────
//
// 验收原文：「开关关闭时网关行为与现状一致（仍剥调用方 Authorization）」。
// 所以第一条用例量的是**路由不存在**，不是"返回 404"——路径存在与否是两回事。
//
//   1. 默认关：registerLineExchange() 挂 0 条路由；/api/lines/* 仍归兜底；
//   2. 开全局但名单为空：仍然 0 条（配了钥匙不等于开了出口）；
//   3. 开某线：只挂该线两条（换票 + JWKS），别的线同一路径不存在；
//   4. 换票成功：aud=source=目标线、exp−iat ≤600、jti 每次都不同；
//   5. 令牌能被该线公钥离线验过；拿 A 线的令牌给 B 线验 → wrong_audience，
//      拿 B 线公钥验 A 线令牌 → bad_signature（每线一把钥的意义）；
//   6. 无凭据 401、坏凭据 401、计费面降级 503（不是 401）。
//
//   node --test --test-concurrency=1 scripts/test-line-token-exchange.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LINE_EXCHANGE_MAX_TTL_SECONDS,
  decideLineExchange,
  enabledLines,
  generateTestKeyPair,
  jwksDocument,
  lineSigningKey,
  mintLineToken,
  registerLineExchange,
  verifyLineToken,
} from "../gateway/line-token-exchange.js";

const wireKeys = generateTestKeyPair();
const lexKeys = generateTestKeyPair();

// 一份"开着的"环境：两条线各一把钥，一条线不在名单里（facet）。
const ON = {
  LINE_EXCHANGE_ENABLED: "1",
  LINE_EXCHANGE_LINES: "wire,lex",
  LINE_EXCHANGE_KEY_WIRE: wireKeys.privateKeyPem,
  LINE_EXCHANGE_KID_WIRE: "wire-1",
  LINE_EXCHANGE_KEY_LEX: lexKeys.privateKeyPem,
  LINE_EXCHANGE_KID_LEX: "lex-9",
};

// 记录式假 app：只关心「挂了哪些路由」，不启动 Express。
function fakeApp() {
  const routes = [];
  const record = (method) => (pathname) => {
    routes.push(`${method} ${pathname}`);
  };
  return { routes, post: record("POST"), get: record("GET") };
}

const verifyOk = async (key) => (key === "sk-good" ? { ok: true, userId: 42, email: "c@example.com" } : { ok: false, reason: "invalid_key" });
const verifyDegraded = async () => ({ ok: false, status: 503 });

test("默认关闭：一条路由都不挂", () => {
  const app = fakeApp();
  assert.equal(registerLineExchange(app, { verifyCaller: verifyOk, env: {} }), 0);
  assert.deepEqual(app.routes, []);
  assert.deepEqual(enabledLines({}), []);
});

test("全局打开但名单为空：仍然不挂（钥匙进环境不等于出口打开）", () => {
  const app = fakeApp();
  const env = { ...ON, LINE_EXCHANGE_LINES: "" };
  assert.equal(registerLineExchange(app, { verifyCaller: verifyOk, env }), 0);
  assert.deepEqual(app.routes, []);
});

test("开两条线：只挂这两条的四条路由，未在名单的线不存在", () => {
  const app = fakeApp();
  assert.equal(registerLineExchange(app, { verifyCaller: verifyOk, env: ON }), 4);
  assert.deepEqual(app.routes.sort(), [
    "GET /api/lines/lex/jwks.json",
    "GET /api/lines/wire/jwks.json",
    "POST /api/lines/lex/token",
    "POST /api/lines/wire/token",
  ]);
  assert.ok(!app.routes.some((r) => r.includes("facet")));
});

test("换票：aud/source=目标线，exp−iat≤600，jti 不重复", async () => {
  const first = await decideLineExchange({ line: "wire", authorization: "Bearer sk-good", env: ON, verifyCaller: verifyOk });
  assert.equal(first.status, 200);
  assert.equal(first.claims.aud, "wire");
  assert.equal(first.claims.source, "wire");
  assert.equal(first.claims.sub, "42");
  assert.equal(first.claims.scope, "line:read");
  assert.ok(first.claims.exp - first.claims.iat <= LINE_EXCHANGE_MAX_TTL_SECONDS);

  const second = await decideLineExchange({ line: "wire", authorization: "Bearer sk-good", env: ON, verifyCaller: verifyOk });
  assert.notEqual(first.claims.jti, second.claims.jti);
});

test("TTL 配置超过上限被夹到 600 秒（不是相信配置）", async () => {
  const env = { ...ON, LINE_EXCHANGE_TTL_SECONDS: "99999" };
  assert.equal(lineSigningKey("wire", env).ttlSeconds, LINE_EXCHANGE_MAX_TTL_SECONDS);
  const { claims } = await decideLineExchange({ line: "wire", authorization: "Bearer sk-good", env, verifyCaller: verifyOk });
  assert.equal(claims.exp - claims.iat, LINE_EXCHANGE_MAX_TTL_SECONDS);
});

test("令牌可离线验过；跨线使用被拒（aud 与钥都按线隔离）", async () => {
  const { token } = await decideLineExchange({ line: "wire", authorization: "Bearer sk-good", env: ON, verifyCaller: verifyOk });

  const own = verifyLineToken(token, { publicKey: wireKeys.publicKey, line: "wire" });
  assert.equal(own.ok, true);

  // 拿 wire 的令牌去当 lex 的：签名是 wire 的钥，lex 用自己那把验不过。
  const foreign = verifyLineToken(token, { publicKey: lexKeys.publicKey, line: "lex" });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, "bad_signature");

  // 即便签名合法，aud/source 不匹配也不认（先验签后判 aud，顺序不能反）。
  const wrongAud = verifyLineToken(token, { publicKey: wireKeys.publicKey, line: "lex" });
  assert.equal(wrongAud.ok, false);
  assert.equal(wrongAud.reason, "wrong_audience");
});

test("JWKS 按线发布：只出该线一把，kid 与签发时一致", () => {
  const wire = jwksDocument("wire", ON);
  assert.equal(wire.keys.length, 1);
  assert.equal(wire.keys[0].kid, "wire-1");
  assert.equal(wire.keys[0].alg, "ES256");
  assert.equal(wire.keys[0].d, undefined, "JWKS 不得带私钥分量");
  assert.deepEqual(jwksDocument("facet", ON), { keys: [] });
});

test("失败分支：无凭据/坏凭据 401，计费面降级 503，未开的线 404", async () => {
  const noAuth = await decideLineExchange({ line: "wire", env: ON, verifyCaller: verifyOk });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.error, "missing_credential");

  const bad = await decideLineExchange({ line: "wire", authorization: "Bearer sk-bad", env: ON, verifyCaller: verifyOk });
  assert.equal(bad.status, 401);

  const degraded = await decideLineExchange({ line: "wire", authorization: "Bearer sk-good", env: ON, verifyCaller: verifyDegraded });
  assert.equal(degraded.status, 503);
  assert.equal(degraded.error, "billing_plane_degraded");

  const unopened = await decideLineExchange({ line: "facet", authorization: "Bearer sk-good", env: ON, verifyCaller: verifyOk });
  assert.equal(unopened.status, 404);

  // 开了开关但没给私钥：503（配置缺失，运维可修），不是 500 也不是"签发成功"。
  const noKey = await decideLineExchange({
    line: "wire",
    authorization: "Bearer sk-good",
    env: { ...ON, LINE_EXCHANGE_KEY_WIRE: "" },
    verifyCaller: verifyOk,
  });
  assert.equal(noKey.status, 503);
  assert.equal(noKey.error, "line_signing_key_missing");
});

test("mintLineToken 直接调用也守同一条边界（不靠上层记得夹）", () => {
  const token = mintLineToken({
    line: "wire",
    subject: "42",
    kid: "wire-1",
    privateKey: wireKeys.privateKeyPem,
    ttlSeconds: 99_999,
  });
  const { ok, claims } = verifyLineToken(token, { publicKey: wireKeys.publicKey, line: "wire" });
  assert.equal(ok, true);
  assert.equal(claims.exp - claims.iat, LINE_EXCHANGE_MAX_TTL_SECONDS);
});
