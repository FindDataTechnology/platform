// 记忆分层视图（establish-agent-role-and-fitness-plane 6.4）。
//
// 6.4 要求：往轮摘要从「唯一的连续性来源」降级为「履历的一个视图」，
// 连续性由三层记忆提供。这条最容易走过场——把标题改个名字就算做完了。
// 所以判据盯的是**行为**：
//   · 没有可读层次时返回 null（不是空段落占位）
//   · 「没读到」与「确实没有」必须可区分
//   · 往轮记录的抬头必须自陈它只是其中一层
//
// Run: node --test scripts/test-memory-layers.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { renderMemoryLayers, renderSelfBlock, pickSelfRounds } = await import("../server/fleet-context.js");

test("可读层次全空 ⇒ null（不产出空段落）", () => {
  assert.equal(renderMemoryLayers({}), null);
  assert.equal(renderMemoryLayers({ domainPages: 0, competences: [] }), null);
  assert.equal(renderMemoryLayers({ domainPages: null, competences: null }), null);
});

test("领域记忆页数 > 0 时列出，并注明它由注入面提供", () => {
  const t = renderMemoryLayers({ domainPages: 12 });
  assert.ok(t.includes("领域记忆 12 页"));
  assert.ok(t.includes("注入面"));
});

test("胜任力三态分别计数（生效/被质疑/待验收），不是只报总数", () => {
  const t = renderMemoryLayers({ competences: [{ state: "active" }, { state: "active" }, { state: "disputed" }, { state: "candidate" }] });
  assert.ok(t.includes("生效 2"), t);
  assert.ok(t.includes("被质疑 1"));
  assert.ok(t.includes("待验收 1"));
});

test("往轮记录的抬头自陈「履历的一个视图」（不是唯一来源）", () => {
  const block = renderSelfBlock({ kpiSlots: [] }, []);
  assert.ok(block.includes("履历的一个视图"), "抬头必须写明它只是其中一层");
  assert.ok(!/"唯一的连续性来源"/.test(block));
});

test("分层视图渲染在往轮记录之前（先说自己有哪些层次，再给履历）", () => {
  const layers = renderMemoryLayers({ domainPages: 3 });
  const block = renderSelfBlock({ kpiSlots: [] }, [], layers);
  const iLayers = block.indexOf("我的记忆分层");
  const iRounds = block.indexOf("最近轮次");
  assert.ok(iLayers >= 0 && iRounds > iLayers, "层次在前，履历在后");
});

test("不传层次 ⇒ 与改前形状一致（老调用方零迁移）", () => {
  const a = renderSelfBlock({ kpiSlots: [] }, []);
  const b = renderSelfBlock({ kpiSlots: [] }, [], null);
  assert.equal(a, b);
  assert.ok(!a.includes("我的记忆分层"));
});

test("往轮选取逻辑未被改动（pickSelfRounds 仍按会话去重）", () => {
  const reports = [
    { sessionId: "s1", createdAt: 300 },
    { sessionId: "s1", createdAt: 290 },
    { sessionId: "s2", createdAt: 200 },
  ];
  const rounds = pickSelfRounds(reports);
  assert.equal(rounds.length, 2, "同会话的多条只算一轮");
});
