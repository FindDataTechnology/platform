// 角色五器官与状态三态（establish-agent-role-and-fitness-plane 5.1 / 5.3 / 5.4）。
//
// 每一条都在挡「声明了但没生效 / 没声明被读成已声明 / 空转被报成健康」的一种形态。
//
// Run: node --test lib/agent-role.test.js

import assert from "node:assert/strict";
import { test } from "node:test";

const { validateOrgans, deriveRoleStatus, adoptionTransition, ORGANS, looksLikeAddress } = await import("./agent-role.js");

test("空值与省略必须可区分：显式 null 记进 gaps，省略仍算缺器官", () => {
  const explicit = validateOrgans({ charter: null, hands: {} });
  assert.equal(explicit.ok, true);
  assert.deepEqual(explicit.gaps.sort(), ["charter", "memory", "objective", "senses"]);
  const omitted = validateOrgans({ hands: {} });
  assert.equal(omitted.ok, false);
  assert.ok(omitted.errors.some((e) => e.code === "organ_missing" && e.entry === "organs.charter"));
});

test("拼错的器官键点名拒绝，且给出已知集合", () => {
  const r = validateOrgans({ charter: "x", hands: {}, senes: [] });
  assert.equal(r.ok, false);
  const e = r.errors.find((x) => x.code === "organ_unknown");
  assert.ok(e && e.error.includes("senes") && e.error.includes("senses"));
});

test("感官面是裸 URL / 带端口 / 带 @ ⇒ 逐字拒（只接受在册具名读面）", () => {
  for (const bad of ["https://news.example.com/rss", "news.example.com:8080", "user@host"]) {
    const r = validateOrgans({ charter: "x", hands: {}, senses: [{ surface: bad, cadence: { cron: "0 1 * * *" }, changeRule: "标题变化" }] });
    assert.equal(r.ok, false, `${bad} 应被拒`);
    assert.ok(r.errors.some((e) => e.code === "sense_surface_is_address"), bad);
  }
  assert.equal(looksLikeAddress("例如"), false);
});

test("感官缺 cadence 或缺 changeRule ⇒ 红（没有节奏/没有变化判据的感官等于没有）", () => {
  const noCadence = validateOrgans({ charter: "x", hands: {}, senses: [{ surface: "fd-info", changeRule: "x" }] });
  assert.ok(noCadence.errors.some((e) => e.code === "sense_cadence_missing"));
  const noRule = validateOrgans({ charter: "x", hands: {}, senses: [{ surface: "fd-info", cadence: {} }] });
  assert.ok(noRule.errors.some((e) => e.code === "sense_change_rule_missing"));
});

test("合法五器官 ⇒ 绿且 gaps 为空", () => {
  const r = validateOrgans({
    charter: "本岗负责对账",
    memory: { store: { home: "member" } },
    senses: [{ surface: "fd-info", cadence: { cron: "0 1 * * *" }, changeRule: "条目新增" }],
    objective: { metricKey: "diffsClosed" },
    hands: { "fd-erp-ledger-mcp": ["query_entries"] },
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.gaps, []);
});

test("记忆轴沿用既有五轴，未知轴点名", () => {
  const r = validateOrgans({ charter: "x", hands: {}, memory: { scopes: [] } });
  assert.ok(r.errors.some((e) => e.code === "memory_axis_unknown" && e.error.includes("scopes")));
});

test("状态三态：零回合 ⇒ down；全失败 ⇒ down；成功但零产出 ⇒ idle", () => {
  assert.equal(deriveRoleStatus({ turns: [] }).status, "down");
  assert.equal(deriveRoleStatus({ turns: [{ status: "failed" }, { status: "failed" }] }).status, "down");
  const idle = deriveRoleStatus({ turns: [{ status: "ok" }, { status: "ok" }], hasObjective: true, outputs: 0 });
  assert.equal(idle.status, "idle");
  assert.ok(idle.basis.includes("跑完了不等于做完了"));
});

test("成功且有产出 ⇒ producing；没有 objective 时如实标「空转判不了」而不是报健康", () => {
  assert.equal(deriveRoleStatus({ turns: [{ status: "ok" }], hasObjective: true, outputs: 3 }).status, "producing");
  const unjudged = deriveRoleStatus({ turns: [{ status: "ok" }], hasObjective: false });
  assert.equal(unjudged.status, "producing");
  assert.equal(unjudged.unjudged, "objective");
  const noOutputs = deriveRoleStatus({ turns: [{ status: "ok" }], hasObjective: true });
  assert.equal(noOutputs.unjudged, "outputs");
});

test("采纳：同基因组升版可采纳；换基因组被拒；同版本是 noop", () => {
  const ok = adoptionTransition({ current: { packId: "P", version: 3 }, target: { packId: "P", version: 4 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.noop, false);
  assert.deepEqual(ok.before, { packId: "P", version: 3 });

  const wrong = adoptionTransition({ current: { packId: "P", version: 3 }, target: { packId: "Q", version: 1 } });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.error.includes("重铸"));

  const same = adoptionTransition({ current: { packId: "P", version: 3 }, target: { packId: "P", version: 3 } });
  assert.equal(same.noop, true);
});

test("器官清单是闭集，新增器官必须同时改这里", () => {
  assert.deepEqual([...ORGANS], ["charter", "memory", "senses", "objective", "hands"]);
});
