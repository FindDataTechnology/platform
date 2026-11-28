// Audience projection (agent-as-employee-model 5.4).
// Run: node --test scripts/test-audience-projection.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { project } from "../lib/audience-projection.js";

const ok = (value) => ({ ok: true, value });
const facts = {
  spend: ok({ windows: { "30d": { costUsd: 12.5, turns: 40 } } }),
  turns: ok([{ status: "ok", startedAt: 2, memberId: "a" }, { status: "failed", startedAt: 1, memberId: "b" }]),
  reports: ok([
    { id: "r1", memberId: "a", summary: "did x", blockers: ["缺少 ERP 写权限"], metrics: { orders: 3 }, createdAt: 5 },
    { id: "r2", memberId: "b", summary: "did y", blockers: [], metrics: {}, createdAt: 4 },
  ]),
  openDecisions: ok([{ id: "d1", memberId: "a", title: "批准报价", expiresAt: 99 }]),
  role: ok({ organs: { charter: "守规则", hands: ["erp.read"] } }),
  member: ok({ contextBudget: 64000 }),
};

test("成本在 general 与 professional 一致", () => {
  assert.deepEqual(project("general", facts).cost, project("professional", facts).cost);
  assert.equal(project("general", facts).cost.usd, 12.5);
});

test("general 覆盖六类且不含逐回合明细，带跳转", () => {
  const g = project("general", facts);
  for (const k of ["reports", "progress", "difficulties", "cost", "outcomes", "commitments"]) assert.ok(k in g, k);
  assert.ok(!("turns" in g));
  assert.equal(g.detailRef, "professional");
  assert.equal(g.difficulties[0].text, "缺少 ERP 写权限");
});

test("计费源不可用 ⇒ 未取得：source_unavailable，不是 0", () => {
  const g = project("general", { ...facts, spend: { ok: false, error: "db down" } });
  assert.equal(g.cost.unavailable, "source_unavailable");
  assert.notEqual(g.cost.usd, 0);
});

test("未声明的源 ⇒ undeclared", () => {
  const s = project("self", facts, { memberId: "a" });
  assert.equal(s.teamNotices.unavailable, "undeclared");
  assert.equal(s.visibleMemory.unavailable, "undeclared");
});

test("self 只看自己：别人的报告不出现", () => {
  const s = project("self", facts, { memberId: "a" });
  assert.equal(s.myLatestReport.memberId, "a");
  assert.ok(!JSON.stringify(s).includes("did y"));
  assert.deepEqual(s.permissions, ["erp.read"]);
  assert.equal(s.budget.contextBudget, 64000);
});

test("self 记忆源拒绝 ⇒ forbidden，内容不泄露", () => {
  const s = project("self", { ...facts, memoryScope: { ok: false, error: "scope denied" } }, { memberId: "a" });
  assert.equal(s.visibleMemory.unavailable, "forbidden");
});

test("未知受众被拒", () => {
  assert.ok(project("boss", facts).error);
});
