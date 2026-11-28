// 感官观测（establish-agent-role-and-fitness-plane 7.2 / 7.3）。
//
// 每一条都对着一种「看起来在工作、其实没看见」的形态：
//   · 未取得被写成「无变化」（把一次失败的调用读成一个结论）
//   · 首次观测被当成「无变化」
//   · 上一轮未取得时，本轮取得被当成变化
//   · metadata 走错车道（写成新 type 会被服务端 400）
//
// Run: node --test lib/fleet-senses.test.mjs —— 用 .mjs 是因为要被 node --test 直跑

import assert from "node:assert/strict";
import { test } from "node:test";

const { diffObservations, observationPage, writeObservation, readLastObservation, MISSING_REASONS, OBSERVATION_KIND } = await import("./fleet-senses.js");

test("未取得必须带原因，且文案明确不是「无变化」", () => {
  const d = diffObservations({ items: [] }, { missing: "network" });
  assert.equal(d.status, "missing");
  assert.equal(d.reason, "network");
  assert.ok(d.text.includes("不是「无变化」"));
});

test("未取得的原因不在闭集里 ⇒ 归为 unknown（不编一个具体原因）", () => {
  assert.equal(diffObservations(null, { missing: "cosmic-rays" }).reason, "unknown");
  for (const r of MISSING_REASONS) assert.ok(["ok", "unchanged", "missing"].includes(diffObservations(null, { missing: r }).status));
});

test("首次取得 ⇒ ok，且明说「无可比的上一条」", () => {
  const d = diffObservations(null, { surface: "fd-info", items: [{ id: "a" }] });
  assert.equal(d.status, "ok");
  assert.ok(d.text.includes("首次"));
});

test("上轮未取得、本轮取得 ⇒ 不能谎称「变化」", () => {
  const d = diffObservations({ missing: "upstream" }, { surface: "fd-info", items: [{ id: "a" }] });
  assert.equal(d.status, "ok");
  assert.ok(d.text.includes("上轮未取得"), d.text);
});

test("真正无变化 ⇒ unchanged（与 missing 分开）", () => {
  const d = diffObservations({ items: [{ id: "a" }, { id: "b" }] }, { surface: "fd-info", items: [{ id: "b" }, { id: "a" }] });
  assert.equal(d.status, "unchanged");
});

test("新增与消失分别计数", () => {
  const d = diffObservations({ items: [{ id: "a" }, { id: "b" }] }, { surface: "fd-info", items: [{ id: "b" }, { id: "c" }, { id: "d" }] });
  assert.equal(d.status, "ok");
  assert.ok(d.text.includes("新增 2"), d.text);
  assert.ok(d.text.includes("消失 1"), d.text);
});

test("观测页走 note + metadata，不开新 type 车道", () => {
  const p = observationPage({ surface: "fd-info", at: "2026-11-23T04:00:00Z", items: [{ id: "a", title: "A", source: "x" }] });
  assert.equal(p.metadata.kind, OBSERVATION_KIND);
  assert.equal(p.metadata.surface, "fd-info");
  assert.equal(p.metadata.at, "2026-11-23T04:00:00Z");
  assert.equal(p.metadata.source, undefined, "未给 source 时不该有该键");
  assert.ok(p.body.includes("来源：fd-info"));
  assert.ok(p.body.includes("出处：x"), "条目自带出处");
});

test("未取得的观测页：正文写明原因，metadata 也标 missing", () => {
  const p = observationPage({ surface: "fd-info", missing: "credentials" });
  assert.equal(p.metadata.missing, "credentials");
  assert.ok(p.body.includes("credentials"));
  assert.ok(p.body.includes("不是「无变化」"));
});

test("surface 必填（没有读面的观测没有意义）", () => {
  assert.throws(() => observationPage({}), /surface is required/);
});

test("写失败如实返回 error，不静默当成功", async () => {
  const failing = { writeDigest: async () => { throw new Error("HTTP 503"); } };
  const r = await writeObservation(failing, "p", observationPage({ surface: "s" }));
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("503"));
});

test("记忆客户端缺席 ⇒ 写返回 memory-unavailable（不是抛）", async () => {
  assert.deepEqual(await writeObservation(null, "p", {}), { ok: false, error: "memory-unavailable" });
});

test("写观测把 metadata 传进 writeDigest 的第 4 参", async () => {
  let seen = null;
  const client = { writeDigest: async (proj, title, _body, opts) => { seen = { proj, title, opts }; } };
  const page = observationPage({ surface: "fd-info", items: [] });
  await writeObservation(client, "proj-1", page);
  assert.equal(seen.proj, "proj-1");
  assert.deepEqual(seen.opts.metadata, page.metadata);
});

test("读上一条观测按 metadata 过滤（不在客户端筛）", async () => {
  let query = null;
  const client = { readPages: async (f) => { query = f; return [{ title: "prev" }]; } };
  const row = await readLastObservation(client, "p", "fd-info");
  assert.deepEqual(query.metadata, { kind: OBSERVATION_KIND, surface: "fd-info" });
  assert.equal(row.title, "prev");
});

test("老客户端（无 readPages）⇒ 返回 null，不抛", async () => {
  assert.equal(await readLastObservation({ writeDigest: async () => {} }, "p", "s"), null);
});
