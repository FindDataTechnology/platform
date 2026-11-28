// ── 探针判据 + 通道可达性（fix-disclosure-gate-reachability D4）──────────────
//
// 钉两件事：
//   1. 「200 但形状不对」不算通——上游改形状是这条链上最常见的静默失效形态；
//   2. 探针缺配置、401、404、超时、非 JSON 一律不可达（失败关闭）。
//
// 这里**不**测「注入凭据就 ok」：那正是今晚的假绿，测它等于把 bug 钉成契约。
//
// Run: node --test scripts/test-mandate-verdict-probe.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { decideReachability, probeMandateVerdict } = await import("../lib/mandate-verdict-probe.js");

const CFG = { url: "http://127.0.0.1:3100", token: "t0ken", owner: "owner@example.com" };

test("判据：2xx + ok + decision 才算可达", () => {
  assert.equal(decideReachability({ status: 200, body: { ok: false, decision: "draft" } }).reachable, true);
  assert.equal(decideReachability({ status: 200, body: { ok: true, decision: "send" } }).reachable, true);
});

test("判据：200 但形状不对→不可达（不是「通了」）", () => {
  for (const body of [null, [], "text", {}, { ok: "yes", decision: "draft" }, { ok: true }, { ok: true, decision: "" }]) {
    const r = decideReachability({ status: 200, body });
    assert.equal(r.reachable, false, `形状 ${JSON.stringify(body)} 不能算通`);
  }
  assert.equal(decideReachability({ status: 200, body: {} }).reason, "shape_no_ok");
  assert.equal(decideReachability({ status: 200, body: { ok: true } }).reason, "shape_no_decision");
});

test("判据：401 / 404 / 503 各自有名，便于体检说清是哪一段", () => {
  assert.equal(decideReachability({ status: 401, body: {} }).reason, "http_401");
  assert.equal(decideReachability({ status: 404, body: {} }).reason, "http_404");
  assert.equal(decideReachability({ status: 503, body: {} }).reason, "http_503");
});

test("探针：缺 URL / TOKEN / OWNER 任一 → 不可达，且不发请求", async () => {
  let called = 0;
  const fetchImpl = async () => {
    called++;
    throw new Error("should not be called");
  };
  for (const over of [{ url: "" }, { token: "" }, { owner: "" }]) {
    const r = await probeMandateVerdict({ ...CFG, ...over, fetchImpl });
    assert.equal(r.reachable, false);
    assert.equal(r.reason, "not_configured");
  }
  assert.equal(called, 0, "没配齐就不该打网络——那是一定会失败的调用");
});

test("探针：带上 owner 头与 bearer，路径正确", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { status: 200, json: async () => ({ ok: false, decision: "draft", reason: "no_policy" }) };
  };
  const r = await probeMandateVerdict({ ...CFG, fetchImpl });
  assert.equal(r.reachable, true);
  assert.match(seen.url, /\/api\/actions\/mandate-verdict$/);
  assert.equal(seen.init.headers.authorization, "Bearer t0ken");
  assert.equal(seen.init.headers["x-mandate-owner"], "owner@example.com");
});

test("探针：抛异常 → 不可达（不把异常当通过）", async () => {
  const r = await probeMandateVerdict({ ...CFG, fetchImpl: async () => { throw new Error("boom"); } });
  assert.equal(r.reachable, false);
  assert.equal(r.reason, "error");
});
