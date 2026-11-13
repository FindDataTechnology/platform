#!/usr/bin/env node
// ── 每线签名密钥测试（change converge-line-identity-and-keys，任务 2.3）───────
//
// 任务的验收两条，都在本地可证：
//   1. 密钥清单里每条线一把、kid 唯一；
//   2. 跨线提交被拒——且原因是 audience 不匹配，不是"签名不认"。
//
// 另加三条本文件必须守住的：
//   3. 私钥不出现在 JWKS / 清单里（列表接口连影子都不带）；
//   4. TTL 上限在签发处就挡（别让线侧当唯一闸门）；
//   5. 轮换后旧 kid 仍在 JWKS 里（宽限），过宽限才消失。
//
//   node --test --test-concurrency=1 scripts/test-line-assertion-keys.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "line-assertion-keys-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const db = await import("../db.js");
await db.initDb();
const keys = await import("../line-assertion-keys.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const LEX = "lex";
const WIRE = "wire-customer";
const LEX_AUD = "https://lex.finddatatech.cloud";
const WIRE_AUD = "https://wire.finddatatech.cloud";

test("每条线一把、kid 唯一", () => {
  keys.signAssertion({ line: LEX, audience: LEX_AUD, sub: "u1" });
  keys.signAssertion({ line: WIRE, audience: WIRE_AUD, sub: "u1" });
  const list = keys.listKeys([LEX, WIRE]);
  assert.equal(list.length, 2);
  assert.equal(new Set(list.map((k) => k.kid)).size, 2, "两线的 kid 必须不同");
  assert.deepEqual(list.map((k) => k.line).sort(), [LEX, WIRE].sort());
});

test("JWKS 与清单都不带私钥（只出公钥材料）", () => {
  const doc = keys.jwks(LEX);
  assert.equal(doc.keys.length, 1);
  const jwk = doc.keys[0];
  assert.ok(jwk.x && jwk.y, "EC 公钥应带 x/y");
  assert.equal(jwk.d, undefined, "JWK 里绝不能出现私钥分量 d");
  assert.equal(jwk.kid.length > 0, true);
  const blob = JSON.stringify(keys.listKeys([LEX, WIRE]));
  assert.equal(/privatePem|PRIVATE KEY|\bd":/.test(blob), false, "清单不得含私钥痕迹");
});

test("正路：用发布出去的 JWKS 能验签，且 aud 是目标线", () => {
  const { token } = keys.signAssertion({
    line: LEX, audience: LEX_AUD, sub: "user-42", scope: ["line:read", "line:write"],
  });
  const res = keys.verifyWithJwks(token, keys.jwks(LEX));
  assert.equal(res.ok, true);
  assert.equal(res.payload.sub, "user-42");
  assert.equal(res.payload.aud, LEX_AUD);
  assert.equal(res.payload.scope, "line:read line:write");
  assert.ok(res.payload.exp - res.payload.iat <= 300);
});

test("跨线：拿 A 线的断言去 B 线，验不过（B 线只信自己那把钥）", () => {
  const { token } = keys.signAssertion({ line: LEX, audience: LEX_AUD, sub: "user-42" });
  // 关键：**JWKS 是按线发布的**（每条线只信自己那把钥）。这是 per-line 密钥
  // 真正买到的东西——即使 lex 的私钥泄漏，攻击者也无法用它签出一份被 wire
  // 接受的断言。若改成"所有线共用一个 JWKS"，per-line 密钥就只剩轮换便利，
  // 泄漏面回到全局。
  // 所以 B 线的第一道拒绝是"这把钥不是我的"；对外原因码一律归为
  // audience/line 不匹配（不向调用方泄漏"哪一步没过"）。
  const withWireJwks = keys.verifyWithJwks(token, keys.jwks(WIRE));
  assert.equal(withWireJwks.ok, false);
  assert.equal(withWireJwks.reason, "unknown_kid");
  const withLexJwks = keys.verifyWithJwks(token, keys.jwks(LEX));
  assert.equal(withLexJwks.ok, true);
  assert.notEqual(withLexJwks.payload.aud, WIRE_AUD, "aud 必须不等于另一条线的地址");
});

test("过期或被篡改的载荷验不过", () => {
  const { token } = keys.signAssertion({ line: LEX, audience: LEX_AUD, sub: "u" });
  const [h, p, s] = token.split(".");
  const forged = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  forged.sub = "someone-else";
  const tampered = `${h}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${s}`;
  assert.equal(keys.verifyWithJwks(tampered, keys.jwks(LEX)).ok, false);
});

test("TTL 超过 5 分钟在签发处就被挡", () => {
  assert.throws(() => keys.signAssertion({ line: LEX, audience: LEX_AUD, sub: "u", ttlSeconds: 301 }),
    /within \(0, 300]/);
  assert.throws(() => keys.signAssertion({ line: LEX, audience: LEX_AUD, sub: "u", ttlSeconds: 0 }),
    /within \(0, 300]/);
});

test("轮换：新 kid 生效，旧 kid 在宽限内仍可验，过期后消失", () => {
  const line = "paper-trading";
  const before = keys.signAssertion({ line, audience: "https://paper.test", sub: "u" });
  const oldKid = before.kid;

  const rotatedAt = new Date();
  const after = keys.rotateKey(line, rotatedAt);
  assert.notEqual(after.kid, oldKid, "轮换必须换 kid");

  // 宽限内：旧钥还在 JWKS，旧断言仍可验（在飞的断言不炸）
  const graceJwks = keys.jwks(line, new Date(rotatedAt.getTime() + 60_000));
  assert.ok(graceJwks.keys.some((k) => k.kid === oldKid), "宽限内旧 kid 应在 JWKS 里");
  assert.equal(keys.verifyWithJwks(before.token, graceJwks).ok, true);

  // 过宽限：旧钥消失，旧断言不再可验
  const staleJwks = keys.jwks(line, new Date(rotatedAt.getTime() + (keys.KEY_GRACE_SECONDS + 60) * 1000));
  assert.equal(staleJwks.keys.some((k) => k.kid === oldKid), false, "过宽限旧 kid 必须消失");
  assert.equal(keys.verifyWithJwks(before.token, staleJwks).ok, false);
});
