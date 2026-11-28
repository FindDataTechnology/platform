// 店面子代理（/shop/*）：身份模型与 ERP 后台不同，这组测试守那条差别。
//
// 三条判据：
//   1. **匿名可读**——没有会话也放行（店面访客没有账号）；
//   2. **委托头只认验签**——伪造的 x-erp-grant-* 必须被剥掉；
//   3. **无 grant 时不注入**——行为与改造前相同。

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { CLIENT_IDENTITY_HEADERS_FOR_TEST, resolveIdentityHeaders } from "./erp-proxy.js";
import { _resetGrantKeyCache, verifyGrant } from "../grant-verify.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "EdDSA", use: "sig" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const future = () => Math.floor(Date.now() / 1000) + 600;
const fetchOk = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });

function grant(over = {}) {
  const h = b64({ alg: "EdDSA", kid: "k1", typ: "JWT" });
  const p = b64({ sub: "agent:x", aud: "erp-vertical-api", jti: "j1", budget: { amount: "200" }, exp: future(), ...over });
  const input = `${h}.${p}`;
  return `${input}.${sign(null, Buffer.from(input, "utf8"), privateKey).toString("base64url")}`;
}

test("委托头在客户端可伪造清单里（会被剥掉）", () => {
  assert.ok(CLIENT_IDENTITY_HEADERS_FOR_TEST.includes("x-erp-grant-jti"));
  assert.ok(CLIENT_IDENTITY_HEADERS_FOR_TEST.includes("x-erp-grant-budget"));
});

test("有已验签的 grant 才注入委托头", () => {
  const h = resolveIdentityHeaders(
    { email: "a@example.com" },
    { deploymentTenantId: "acme", bindings: {}, grant: { jti: "j1", budget: { amount: "200" } } },
  );
  assert.equal(h["x-erp-grant-jti"], "j1");
  assert.equal(h["x-erp-grant-budget"], "200");
});

test("无 grant 时不注入（与改造前逐字节相同）", () => {
  const h = resolveIdentityHeaders({ email: "a@example.com" }, { deploymentTenantId: "acme", bindings: {} });
  assert.equal(h["x-erp-grant-jti"], undefined);
  assert.equal(h["x-erp-grant-budget"], undefined);
});

test("grant 缺 jti 或 budget 时只注入存在的那项", () => {
  const onlyJti = resolveIdentityHeaders({ email: "a@x" }, { deploymentTenantId: "acme", bindings: {}, grant: { jti: "j9" } });
  assert.equal(onlyJti["x-erp-grant-jti"], "j9");
  assert.equal(onlyJti["x-erp-grant-budget"], undefined);
});

test("伪造 token 验不过 → 不产生委托头", async () => {
  _resetGrantKeyCache();
  // Forge by flipping a bit in the DECODED signature, never in its base64url
  // text. A 64-byte Ed25519 signature encodes to 86 base64url chars, and the
  // last char carries only the top 2 bits — 16 chars (wxyz0123456789-_) decode
  // to the SAME bytes. "Replace the last char with A/B" is therefore a no-op
  // ~1/4 of the time and the token stays valid (measured red twice: 2026-11-25
  // shard 6, and again 2026-11-27 shard 3 — the first fix swapped one flaky
  // substitution for a subtler one). Flipping a bit in the bytes is exact.
  const [head, payload, sigText] = grant().split(".");
  const sig = Buffer.from(sigText, "base64url");
  sig[0] ^= 0x01;
  const forged = `${head}.${payload}.${sig.toString("base64url")}`;
  const claims = await verifyGrant(forged, {
    jwksUrl: "http://x/api/jwks", fetchImpl: fetchOk, audiences: ["erp-vertical-api"], warn: () => {},
  });
  assert.equal(claims, null);
  // The un-forged token must still verify — otherwise this test would pass for
  // the wrong reason (a broken key or a bad fixture, not a rejected signature).
  _resetGrantKeyCache();
  assert.notEqual(
    await verifyGrant(grant(), {
      jwksUrl: "http://x/api/jwks", fetchImpl: fetchOk, audiences: ["erp-vertical-api"], warn: () => {},
    }),
    null,
    "the control token must verify, or the forgery proves nothing",
  );
  const h = resolveIdentityHeaders(
    { email: "a@x" },
    { deploymentTenantId: "acme", bindings: {}, grant: claims },
  );
  assert.equal(h["x-erp-grant-jti"], undefined);
});

test("有效 token 的 budget 原样透出（不重算）", async () => {
  _resetGrantKeyCache();
  const claims = await verifyGrant(grant(), {
    jwksUrl: "http://x/api/jwks", fetchImpl: fetchOk, audiences: ["erp-vertical-api"], warn: () => {},
  });
  assert.equal(claims.budget.amount, "200");
});
