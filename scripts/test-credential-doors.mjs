#!/usr/bin/env node
// ── 按门的凭据分组（change converge-line-identity-and-keys 4.2）─────────────
//
// 这一层不做第二个读面：状态由 `/api/connections` 的统一投影独占，本层只归类。
// 所以断言针对的是**归类正确性**，而不是再去读一遍凭据：
//
//   1. 三扇门齐全且顺序固定（从最省事的一把钥到各家自己的）；
//   2. 词元那把钥只出现在门 K，不随吃它的线数量增加；
//   3. 门 A 默认关就必须报 declared/enabled=false（配置事实，不是推断）；
//   4. 分类表覆盖不到的新条目落进 unclassified 并被看见，不会被静默塞进第三方；
//   5. 分组只返回 id 引用，不夹带状态——状态只在一个地方算。
//
//   node --test --test-concurrency=1 scripts/test-credential-doors.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { DOOR_ORDER, DOOR_OF, doorOf, doorOfRef, groupDoors } = await import("../server/lib/credential-doors.js");
const { FEDERATED_LINES } = await import("../federated-ref.js");

//: `/api/connections` 实际会发出的条目 id（读自 misc.js 的构造顺序）。
const LIVE_IDS = [
  "registry",
  "facet-market",
  "connector",
  "line-wire-customer",
  "line-lex",
  "ciyuan-account",
  "paper-trading",
  "chatwoot",
  "search",
];

const asItems = (ids) => ids.map((id) => ({ id, name: id, state: "connected", reason: null }));

test("三扇门齐全且顺序固定", () => {
  const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES);
  assert.deepEqual(g.order, ["customer-key", "member-assertion", "third-party"]);
  assert.deepEqual(g.doors.map((d) => d.id), DOOR_ORDER);
});

test("分类表覆盖 /api/connections 实际发出的每一条", () => {
  const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES);
  assert.deepEqual(g.unclassified, [], `未归类的条目: ${g.unclassified.join(",")}`);
  for (const id of LIVE_IDS) assert.ok(doorOf(id), `${id} 必须在 DOOR_OF 里表态`);
});

test("门 K 只有一把钥，不随消费它的线数量增加", () => {
  const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES);
  const k = g.doors.find((d) => d.id === "customer-key");
  assert.deepEqual(k.connections, ["ciyuan-account"], "多条线吃同一把钥 ≠ 多把钥");
});

test("门 A 默认关：declared/enabled 如实报，不画成可用", () => {
  const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES);
  assert.equal(g.memberAssertion.declared, false, "此刻没有线声明代做");
  assert.equal(g.memberAssertion.enabled, false);
  assert.deepEqual(g.memberAssertion.lines, []);
  // 旧成形但开关没开的线也不能被当成"已声明"：
  const withLines = groupDoors(asItems(LIVE_IDS), {
    lex: { line: "lex", jitPolicy: "off", exchangeUrl: null, enabled: false, ownTrack: "lex-pat" },
  });
  assert.equal(withLines.memberAssertion.declared, false, "jit=off 且无兑换地址 = 没有门 A");
});

test("真声明了代做的线才会进成员门", () => {
  const g = groupDoors(asItems(LIVE_IDS), {
    lex: { line: "lex", jitPolicy: "consent", exchangeUrl: "https://lex.test/api/auth/exchange", enabled: true, ownTrack: "lex-pat" },
  });
  assert.equal(g.memberAssertion.declared, true);
  assert.equal(g.memberAssertion.enabled, true);
  assert.deepEqual(g.memberAssertion.lines, [
    { line: "lex", enabled: true, jitPolicy: "consent", exchangeUrl: "https://lex.test/api/auth/exchange", ownTrack: "lex-pat" },
  ]);
});

test("第三方门收其余自有凭据，词元不在其中", () => {
  const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES);
  const t = g.doors.find((d) => d.id === "third-party");
  for (const id of ["registry", "connector", "chatwoot", "search", "paper-trading"]) {
    assert.ok(t.connections.includes(id), `${id} 属第三方`);
  }
  assert.equal(t.connections.includes("ciyuan-account"), false, "词元不属于第三方门");
});

test("未知条目进 unclassified 而不是被静默塞进第三方", () => {
  const g = groupDoors(asItems([...LIVE_IDS, "brand-new-thing"]), FEDERATED_LINES);
  assert.deepEqual(g.unclassified, ["brand-new-thing"]);
  const t = g.doors.find((d) => d.id === "third-party");
  assert.equal(t.connections.includes("brand-new-thing"), false, "没表态就不许归类");
});

test("分组只带 id 引用，不夹带状态（状态只在一处算）", () => {
  const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES);
  for (const d of g.doors) {
    for (const c of d.connections) assert.equal(typeof c, "string", "门里只能放 id");
  }
  const blob = JSON.stringify(g);
  assert.equal(/sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9._-]{8,}|fdt_[A-Za-z0-9]{8,}/.test(blob), false);
  assert.equal(blob.includes('"state"'), false, "分组不该复制状态");
});

test("分类表本身不含已废弃的面板别名（每条都要能对上真实条目）", () => {
  for (const id of Object.keys(DOOR_OF)) {
    assert.ok(!id.includes(":"), `${id} 看起来是槽位名而不是连接 id`);
  }
});

test("凭据 ref 名与连接条目 id 是两套命名，doorOfRef 负责对齐", () => {
  // 线自有轨在 ref 表里叫 `wire-customer` / `lex`，连接页条目是
  // `line-wire-customer` / `line-lex`。4.1 接舰队凭据包时正是拿 ref 名去查
  // DOOR_OF，结果三条线全被报成"未归类"——所以这条缝要有断言盯着。
  assert.equal(doorOf("wire-customer"), null, "ref 名直接查表本来就查不到");
  assert.equal(doorOfRef("wire-customer"), "third-party");
  assert.equal(doorOfRef("lex"), "third-party");
  // 已经在表里的 id 与共享钥不受影响。
  assert.equal(doorOfRef("registry"), "third-party");
  assert.equal(doorOfRef("ciyuan-account"), "customer-key");
  assert.equal(doorOfRef(""), null);
  assert.equal(doorOfRef(null), null);
});
