// 委托 Grant 离线验签测试（node:test，与 lib/*.test.js 同法）。
//
// 这组测试的核心是**拒绝伪造**：`jwtPayload` 那种纯解码谁都能过，验签必须挡住
// 篡改、降级（none/HS256）、过期、错 aud。一条不拦，整条预算链就等于没有。

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { _resetGrantKeyCache, bearerFrom, verifyGrant } from "./grant-verify.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "erp-vertical-api:1",
  alg: "EdDSA",
  use: "sig",
};

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function makeGrant(claims, { alg = "EdDSA", kid = "erp-vertical-api:1", key = privateKey } = {}) {
  const header = b64url({ alg, kid, typ: "JWT" });
  const payload = b64url(claims);
  const input = `${header}.${payload}`;
  const sig = alg === "EdDSA" && key ? sign(null, Buffer.from(input, "utf8"), key).toString("base64url") : "";
  return `${input}.${sig}`;
}

const JWKS_URL = "http://registry.test/api/jwks";
const fetchOk = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
const base = { jwksUrl: JWKS_URL, fetchImpl: fetchOk, audiences: ["erp-vertical-api"], warn: () => {} };

const future = () => Math.floor(Date.now() / 1000) + 600;
const validClaims = () => ({
  iss: "mcp-gateway",
  sub: "agent:procurement-acme",
  aud: "erp-vertical-api",
  tenant: "acme",
  jti: "jti-1",
  act: { sub: "aloadtree@gmail.com" },
  budget: { amount: "200", currency: "CNY" },
  iat: Math.floor(Date.now() / 1000),
  exp: future(),
});

test("接受有效 Grant 并返回 claims", async () => {
  _resetGrantKeyCache();
  const claims = await verifyGrant(makeGrant(validClaims()), base);
  assert.equal(claims?.sub, "agent:procurement-acme");
  assert.equal(claims?.jti, "jti-1");
  assert.equal(claims?.budget?.amount, "200");
});

test("拒绝被篡改的 payload", async () => {
  _resetGrantKeyCache();
  const [h, , s] = makeGrant(validClaims()).split(".");
  const tampered = `${h}.${b64url({ ...validClaims(), budget: { amount: "999999", currency: "CNY" } })}.${s}`;
  assert.equal(await verifyGrant(tampered, base), null);
});

test("拒绝 alg=none 的降级攻击", async () => {
  _resetGrantKeyCache();
  assert.equal(await verifyGrant(makeGrant(validClaims(), { alg: "none", key: null }), base), null);
});

test("拒绝 HS256 降级（公钥当 HMAC 密钥的经典攻击）", async () => {
  _resetGrantKeyCache();
  const header = b64url({ alg: "HS256", kid: "erp-vertical-api:1" });
  const payload = b64url(validClaims());
  const token = `${header}.${payload}.${Buffer.from("whatever").toString("base64url")}`;
  assert.equal(await verifyGrant(token, base), null);
});

test("拒绝过期 token", async () => {
  _resetGrantKeyCache();
  const claims = { ...validClaims(), exp: Math.floor(Date.now() / 1000) - 1 };
  assert.equal(await verifyGrant(makeGrant(claims), base), null);
});

test("拒绝 aud 不匹配", async () => {
  _resetGrantKeyCache();
  assert.equal(await verifyGrant(makeGrant({ ...validClaims(), aud: "someone-else" }), base), null);
});

test("JWKS 不可达时不放行（fail-closed）", async () => {
  _resetGrantKeyCache();
  const failing = {
    ...base,
    fetchImpl: async () => {
      throw new Error("network down");
    },
  };
  assert.equal(await verifyGrant(makeGrant(validClaims()), failing), null);
});

test("kid 不在 JWKS 里时拒绝", async () => {
  _resetGrantKeyCache();
  const token = makeGrant(validClaims(), { kid: "unknown-kid" });
  assert.equal(await verifyGrant(token, base), null);
});

test("非三段式结构直接拒", async () => {
  _resetGrantKeyCache();
  assert.equal(await verifyGrant("not-a-jwt", base), null);
  assert.equal(await verifyGrant("", base), null);
});

test("bearerFrom 解析 Bearer 前缀", () => {
  assert.equal(bearerFrom("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(bearerFrom("bearer   x "), "x");
});

test("bearerFrom 无前缀返回空串", () => {
  assert.equal(bearerFrom("abc.def.ghi"), "");
  assert.equal(bearerFrom(""), "");
});

test("不传 fetchImpl 时兜底全局 fetch（不静默判票无效）", async () => {
  // 旧实现：publicKeyFor 调 fetchImpl(...) 抛 "fetchImpl is not a function"，
  // 被 catch 吞成 warn，最终返回 null —— 一张真票被判成伪造，排查方向被带偏。
  _resetGrantKeyCache();
  const origFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({ keys: [jwk] }) }; };
  try {
    const claims = await verifyGrant(makeGrant(validClaims()), {
      jwksUrl: JWKS_URL, audiences: ["erp-vertical-api"], warn: () => {},
    });
    assert.equal(called, true, "应回落到全局 fetch");
    assert.equal(claims?.jti, "jti-1");
  } finally {
    globalThis.fetch = origFetch;
    _resetGrantKeyCache();
  }
});
