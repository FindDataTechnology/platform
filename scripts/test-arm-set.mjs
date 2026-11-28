// 多臂试跑（3.1）：逐臂复用 runTrial，不改它的内部。
//
// 每条用例都在挡一种「多臂跑出来但读不出结论」的形态：
//   · 一臂崩了带走其它臂
//   · 单臂失败被「其它臂绿了」掩盖
//   · 空臂集合被当成「全绿」
//
// Run: node --test scripts/test-arm-set.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { runArmSet } = await import("../server/blueprint-trial.js");

/** 假 runTrial 依赖：按臂名给结论。 */
function fakeDeps(outcomes) {
  return {
    now: () => 1_700_000_000_000,
    fetchManifest: async () => ({ fleet: { name: "t", members: [{ ref: "a", title: "岗" }] } }),
    install: async () => {},
    provision: async ({ packId }) => ({ ok: true, fleetId: `f-${packId}` }),
    startFleet: async () => {},
    fireRound: async () => [],
    collectAndWait: async () => ({ members: [], turns: [], reports: [] }),
    // 用 castPackId 区分臂
    _outcomes: outcomes,
  };
}

const bp = (id, kind) => ({
  castPackId: id,
  castPackVersion: 1,
  ownerEmail: "o@test",
  content: { acceptance: [{ id: "a1", kind: "post-materialized", target: "岗" }] },
  armKind: kind,
  armRef: kind,
});

test("单臂：与直接跑 runTrial 同形（旧调用零迁移）", async () => {
  const r = await runArmSet({ armBlueprints: [bp("P", "team")], deps: fakeDeps({}) });
  assert.equal(r.ok, true);
  assert.equal(r.arms.length, 1);
  assert.equal(r.arms[0].kind, "team");
});

test("两臂：各自独立跑，都留下报告（一条臂一份）", async () => {
  const r = await runArmSet({ armBlueprints: [bp("PC", "control"), bp("PT", "team")], deps: fakeDeps({}) });
  assert.deepEqual(r.arms.map((a) => a.kind), ["control", "team"]);
  for (const a of r.arms) assert.ok(a.report, `${a.kind} 必须有报告`);
});

test("一臂装配失败 ⇒ 只让那一臂红，不带走其它臂", async () => {
  const deps = fakeDeps({});
  // control 臂的 provision 失败
  const orig = deps.provision;
  deps.provision = async (args) => (args.packId === "PC" ? { ok: false, error: "provision failed" } : orig(args));
  const r = await runArmSet({ armBlueprints: [bp("PC", "control"), bp("PT", "team")], deps });
  assert.equal(r.arms.length, 2, "两条臂都必须有结果");
  assert.ok(r.arms[0].report.errors.length > 0, "失败臂要如实记错");
  // 另一臂照样跑完（有自己的报告）
  assert.ok(r.arms[1].report, "另一臂不得被跳过");
});

test("整组绿 = 每一臂都绿；任何一臂不绿 ⇒ 整组不绿（单臂失败不得被掩盖）", async () => {
  const deps = fakeDeps({});
  const orig = deps.provision;
  deps.provision = async (args) => (args.packId === "PC" ? { ok: false, error: "boom" } : orig(args));
  const r = await runArmSet({ armBlueprints: [bp("PC", "control"), bp("PT", "team")], deps });
  assert.equal(r.green, false, "有臂失败 ⇒ 整组不绿");
  assert.ok(r.errors.some((e) => e.includes("control")), "错误要标明是哪一臂");
});

test("空臂集合 ⇒ ok:false（不把「没跑」当成「全绿」）", async () => {
  assert.deepEqual(await runArmSet({ armBlueprints: [], deps: fakeDeps({}) }), {
    ok: false,
    error: "armBlueprints must be a non-empty array",
  });
});

test("一臂抛异常 ⇒ 双保险兜住，其余臂照跑", async () => {
  const deps = fakeDeps({});
  deps.fetchManifest = async ({ packId }) => {
    if (packId === "PC") throw new Error("market unreachable");
    return { fleet: { name: "t", members: [{ ref: "a", title: "岗" }] } };
  };
  const r = await runArmSet({ armBlueprints: [bp("PC", "control"), bp("PT", "team")], deps });
  assert.equal(r.arms.length, 2);
  assert.equal(r.green, false);
});
