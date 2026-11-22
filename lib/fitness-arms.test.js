// 三臂构造（establish-agent-role-and-fitness-plane 3.1）。
//
// 这里的每一条都对应「两臂其实不可比、但报告看起来正常」的一种形态：
// 对照臂换人格、消融臂留悬空边、预算缺失、模板形状两种。
//
// Run: node --test lib/fitness-arms.test.js

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";

const { buildArmSet, buildControlArm, buildAblationArm, normalizeTemplate } = await import("./fitness-arms.js");

const budget = { turnsPerDay: 3, tokensPerTurn: 60000 };

const teamTemplate = {
  name: "三岗团队",
  members: [
    { ref: "watch", title: "巡检岗", parentRef: "decide", target: { kind: "pack-preset", packId: "PK", presetId: "p-watch" }, kpiSlots: [{ key: "n", label: "n" }], cadence: { cron: "0 1 * * *", tz: "Asia/Shanghai", promptTemplate: "巡检并报数 {{fleetContext}}" } },
    { ref: "recon", title: "核对岗", parentRef: "decide", target: { kind: "pack-preset", packId: "PK", presetId: "p-recon" }, kpiSlots: [{ key: "m", label: "m" }] },
    { ref: "decide", title: "拍板岗", parentRef: null, target: { kind: "pack-preset", packId: "PK", presetId: "p-decide" }, kpiSlots: [{ key: "d", label: "d" }] },
  ],
  orchestration: {
    mode: "schedule",
    edges: [
      { kind: "handoff", from: "watch", to: "recon" },
      { kind: "handoff", from: "recon", to: "decide" },
    ],
  },
};

test("对照臂是一人、根岗人格、零编排边", () => {
  const r = buildControlArm(teamTemplate, { budget });
  assert.equal(r.ok, true);
  assert.equal(r.arm.template.members.length, 1);
  assert.equal(r.arm.template.members[0].target.presetId, "p-decide"); // 根岗
  assert.deepEqual(r.arm.template.orchestration.edges, []);
});

test("消融臂清掉引用该岗的边，不留下悬空边", async () => {
  const r = buildAblationArm(teamTemplate, "recon", { budget });
  assert.equal(r.ok, true);
  assert.deepEqual(r.arm.template.members.map((m) => m.ref), ["watch", "decide"]);
  // 两条边都经过 recon ⇒ 都被清掉
  assert.deepEqual(r.arm.template.orchestration.edges, []);
  // 能过同一个解析器（armShapeAgrees 要求 control+team 齐，这里是单臂，直接判解析）
  const parsed = await import("../server/fleet-template.js").then((m) => m.parseFleetTemplate({ fleet: r.arm.template }));
  assert.equal(parsed.ok, true, parsed.error);
});

test("消融唯一成员被拒（那一臂会没人）", () => {
  const single = { name: "一人", members: [{ ref: "solo", target: { kind: "pack-preset", packId: "PK", presetId: "p" } }], orchestration: { edges: [] } };
  assert.equal(buildAblationArm(single, "solo", { budget }).ok, false);
});

test("三臂都过同一个解析器（同一条装台链的离线证明）", () => {
  const r = buildArmSet(teamTemplate, { budget, ablate: ["recon"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.shape.shapes.map((s) => s.kind), ["control", "team", "ablation"]);
  assert.deepEqual(r.shape.shapes.map((s) => s.memberCount), [1, 3, 2]);
});

test("两种输入形状（模板本体 / manifest.fleet）等价", () => {
  assert.equal(normalizeTemplate(teamTemplate).members.length, 3);
  assert.equal(normalizeTemplate({ fleet: teamTemplate }).members.length, 3);
  assert.equal(normalizeTemplate({ name: "roles-only" }), null);
});

test("根岗没有 preset target ⇒ 造不出可比的对照臂（拒绝，而不是换个人格凑）", () => {
  const noPreset = { name: "t", members: [{ ref: "a", target: { kind: "pack-preset" } }], orchestration: { edges: [] } };
  assert.equal(buildControlArm(noPreset, { budget }).ok, false);
});

test("真模板：erp-invoice-fleet 三臂同形", () => {
  const file = path.resolve("..", "fleet-packs", "erp", "erp-invoice-fleet", "template.json");
  if (!fs.existsSync(file)) return; // 单仓 checkout（公开仓）里没有兄弟仓
  const tpl = JSON.parse(fs.readFileSync(file, "utf8"));
  const r = buildArmSet(tpl, { budget, ablate: ["reconciler"] });
  assert.equal(r.ok, true);
  assert.equal(r.shape.shapes.find((s) => s.kind === "team").memberCount, 3);
});

test("预算未声明时三臂仍然构造得出（裁决层才会拒绝）", () => {
  const r = buildArmSet(teamTemplate, {});
  assert.equal(r.ok, true);
  assert.ok(r.arms.every((a) => a.budget === undefined));
});
