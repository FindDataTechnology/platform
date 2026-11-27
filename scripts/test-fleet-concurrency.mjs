#!/usr/bin/env node
// ── Run concurrency tests (fleet-run-concurrency 1.4 / 6.2 / 6.4) ───────────
//
// Each case is a failure this change exists to prevent:
//   · a declared count silently clamped instead of refused;
//   · a ceiling that reads as healthy when a capacity dimension is unreadable;
//   · "3 configured, 1 running" with no way to see which limit won.
//
//   node --test scripts/test-fleet-concurrency.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { concurrencyCeiling } = await import("../lib/fleet-concurrency.js");
const { validateConcurrencyWorkbench, parallelNeedsWorkbench, CONCURRENCY_HARD_MAX } = await import("../server/fleet-model.js");

test("ceiling picks the smallest applicable dimension and names it", () => {
  assert.deepEqual(concurrencyCeiling({ workerCap: 4, fleetInflight: 4, admissionSlots: 8 }), {
    ceiling: 4,
    limitedBy: "worker_pool",
    unreadable: [],
  });
  assert.equal(concurrencyCeiling({ workerCap: 4, fleetInflight: 2, admissionSlots: 8 }).limitedBy, "fleet_inflight");
  assert.equal(concurrencyCeiling({ workerCap: 8, fleetInflight: 8, admissionSlots: 1 }).limitedBy, "admission");
});

test("runner_children only participates when it is provided", () => {
  // Omitted (undefined) ⇒ the carrier is not runner ⇒ inapplicable, not unreadable.
  const withoutRunner = concurrencyCeiling({ workerCap: 4, fleetInflight: 4, admissionSlots: 8 });
  assert.equal(withoutRunner.ceiling, 4);
  assert.ok(!withoutRunner.unreadable.includes("runner_children"), "an inapplicable dimension is not an unreadable one");
  // Provided ⇒ it participates in the minimum.
  const withRunner = concurrencyCeiling({ workerCap: 4, fleetInflight: 4, admissionSlots: 8, runnerChildren: 2 });
  assert.equal(withRunner.ceiling, 2);
  assert.equal(withRunner.limitedBy, "runner_children");
  // Applies but unreadable (null) ⇒ reported as unreadable.
  const unread = concurrencyCeiling({ workerCap: 4, fleetInflight: 4, runnerChildren: null });
  assert.ok(unread.unreadable.includes("runner_children"));
});

test("nothing readable yields null, never a fabricated 1", () => {
  // `null` = applies but cannot be read; `undefined` = does not apply here.
  const r = concurrencyCeiling({ workerCap: null, fleetInflight: null, admissionSlots: null });
  assert.equal(r.ceiling, null);
  assert.equal(r.limitedBy, null);
  assert.deepEqual(r.unreadable, ["worker_pool", "fleet_inflight", "admission"]);
});

test("an inapplicable dimension is NOT reported as unreadable", () => {
  // admissionSlots left undefined = the deployment never wired a memory probe;
  // reporting that as unreadable would make every role permanently unhealthy.
  const r = concurrencyCeiling({ workerCap: 4, fleetInflight: 4 });
  assert.equal(r.ceiling, 4);
  assert.deepEqual(r.unreadable, []);
});

test("a partially unreadable set still decides, and reports what it could not read", () => {
  const r = concurrencyCeiling({ workerCap: null, fleetInflight: 4, admissionSlots: 8 });
  assert.equal(r.ceiling, 4);
  assert.deepEqual(r.unreadable, ["worker_pool"]);
});

test("runner_children undefined is inapplicable; null is unreadable", () => {
  assert.deepEqual(concurrencyCeiling({ workerCap: 4, fleetInflight: 4, runnerChildren: undefined }).unreadable, []);
  assert.deepEqual(concurrencyCeiling({ workerCap: 4, fleetInflight: 4, runnerChildren: null }).unreadable, ["runner_children"]);
});

test("a zero cap means zero slots, not 'ignore this dimension'", () => {
  assert.equal(concurrencyCeiling({ workerCap: 0, fleetInflight: 4, admissionSlots: 8 }).ceiling, 0);
});

test("out-of-range declarations are refused, never clamped", () => {
  for (const bad of [0, -1, 999, 1.5, "two", true]) {
    const r = validateConcurrencyWorkbench({ concurrency: bad });
    assert.ok(r.error, `concurrency ${JSON.stringify(bad)} must be refused`);
    assert.match(r.error, /integer between 1 and/);
  }
  assert.equal(validateConcurrencyWorkbench({ concurrency: null }).concurrency, null);
  assert.equal(validateConcurrencyWorkbench({ concurrency: 1 }).concurrency, 1);
  assert.equal(validateConcurrencyWorkbench({ concurrency: CONCURRENCY_HARD_MAX }).concurrency, CONCURRENCY_HARD_MAX);
});

test("a ceiling lowers the legal range instead of being ignored", () => {
  const r = validateConcurrencyWorkbench({ concurrency: 3 }, { ceiling: 2 });
  assert.ok(r.error);
  assert.match(r.error, /between 1 and 2/);
  assert.equal(validateConcurrencyWorkbench({ concurrency: 2 }, { ceiling: 2 }).concurrency, 2);
});

test("workbench is a closed vocabulary", () => {
  for (const ok of ["off", "auto", null]) assert.equal(validateConcurrencyWorkbench({ workbench: ok }).workbench, ok);
  const bad = validateConcurrencyWorkbench({ workbench: "shared" });
  assert.ok(bad.error);
  assert.match(bad.error, /off\|auto/);
});

test("parallel without isolation is refused on EFFECTIVE values", () => {
  assert.equal(parallelNeedsWorkbench({ concurrency: 3, workbench: "off" }), true);
  // Not declared at this layer ⇒ inherits the chain's "off" default ⇒ refused.
  assert.equal(parallelNeedsWorkbench({ concurrency: 3, workbench: null }), true);
  assert.equal(parallelNeedsWorkbench({ concurrency: 3, workbench: "auto" }), false);
  assert.equal(parallelNeedsWorkbench({ concurrency: 1, workbench: "off" }), false);
  // The whole chain silent ⇒ today's behaviour, never refused.
  assert.equal(parallelNeedsWorkbench({}), false);
});

// ── Assembly-time cross gate (task 2.2) ─────────────────────────────────────
//
// The gate judges EFFECTIVE values: a post may omit `workbench` as long as the
// template's fleet layer declares it. These cases pin both halves — judging the
// declaration alone would reject a legal template, judging nothing would let two
// runs share one directory.
const { parseFleetTemplate } = await import("../server/fleet-template.js");

function templateWith(memberExtra, fleetOrchestration = undefined) {
  return {
    fleet: {
      name: "并行闸模板",
      ...(fleetOrchestration ? { orchestration: fleetOrchestration } : {}),
      members: [
        {
          ref: "w",
          title: "岗",
          target: { kind: "existing-persona", id: "persona-w" },
          kpiSlots: [],
          cadence: null,
          ...memberExtra,
        },
      ],
    },
  };
}

test("并行 + 岗位未声明工作台 + 舰队层 auto ⇒ 合法", () => {
  const r = parseFleetTemplate(templateWith({ concurrency: 3 }, { constraints: { workbench: "auto" } }));
  assert.equal(r.ok, true, r.error);
});

test("并行 + 岗位未声明工作台 + 舰队层也未声明 ⇒ 拒收", () => {
  const r = parseFleetTemplate(templateWith({ concurrency: 3 }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "fleet_member_parallel_needs_workbench");
  assert.match(r.error, /并行运行必须各自独占工作台/);
});

test("并行 + 工作台 off ⇒ 拒收", () => {
  const r = parseFleetTemplate(templateWith({ concurrency: 2, workbench: "off" }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "fleet_member_parallel_needs_workbench");
});

test("一份运行 + 工作台 off ⇒ 合法（今天的形态）", () => {
  assert.equal(parseFleetTemplate(templateWith({ concurrency: 1, workbench: "off" })).ok, true);
  assert.equal(parseFleetTemplate(templateWith({})).ok, true);
});

test("模板字面值域：越界/非整数/错词表被拒", () => {
  for (const bad of [0, 17, 1.5, "two"]) {
    const r = parseFleetTemplate(templateWith({ concurrency: bad }));
    assert.equal(r.ok, false, `concurrency ${JSON.stringify(bad)} must refuse`);
  }
  const wb = parseFleetTemplate(templateWith({ workbench: "shared" }));
  assert.equal(wb.ok, false);
  assert.match(wb.error, /off, auto/);
});

test("漂移：fleet-template 的字面常量与 fleet-model / fleet-orchestration 一致", async () => {
  const tpl = await import("../server/fleet-template.js");
  const model = await import("../server/fleet-model.js");
  assert.equal(tpl.CONCURRENCY_HARD_MAX, model.CONCURRENCY_HARD_MAX);
  assert.deepEqual([...tpl.WORKBENCH_MODES], [...model.WORKBENCH_MODES]);
  assert.deepEqual([...tpl.WORKBENCH_MODES], ["off", "auto"]);
});

// ── Read face (tasks 3.1 / 3.2 / 6.4 / 6.5) ─────────────────────────────────
//
// The failure this face exists to prevent: "configured for 3, silently running 1,
// reads as healthy". Every case here pins one of the four numbers or the reason
// they diverge.
const { buildConcurrencyView } = await import("../server/fleet-concurrency-view.js");

const rec = (state, fleetId = "f", memberId = "m") => ({ state, sourceTag: { fleetId, memberId } });

test("生效值被池宽压下来时必须点名原因", () => {
  const v = buildConcurrencyView({ fleetId: "f", id: "m", concurrency: 3 }, {}, { records: [], env: { TASK_WORKER_MAX: "2" } });
  assert.equal(v.declared, 3);
  assert.equal(v.ceiling, 2);
  assert.equal(v.effective, 2);
  assert.equal(v.limitedBy, "worker_pool");
});

test("生效值被舰队在途上限压下来时点名另一层", () => {
  const v = buildConcurrencyView({ fleetId: "f", id: "m", concurrency: 4 }, {}, { records: [], env: { TASK_WORKER_MAX: "8", FLEET_MAX_INFLIGHT: "2" } });
  assert.equal(v.effective, 2);
  assert.equal(v.limitedBy, "fleet_inflight");
});

test("声明小于天花板时声明值生效、无压顶", () => {
  const v = buildConcurrencyView({ fleetId: "f", id: "m", concurrency: 2 }, {}, { records: [], env: { TASK_WORKER_MAX: "4" } });
  assert.equal(v.declared, 2);
  assert.equal(v.ceiling, 4);
  assert.equal(v.effective, 2);
});

test("三层继承来源可点名", () => {
  const fleet = { orchestration: { constraints: { concurrency: 2 } } };
  const v = buildConcurrencyView({ fleetId: "f", id: "m", concurrency: null }, fleet, { records: [], env: { TASK_WORKER_MAX: "4" } });
  assert.equal(v.declared, 2);
  assert.equal(v.source, "fleet");
  const vd = buildConcurrencyView({ fleetId: "f", id: "m" }, {}, { records: [], env: { TASK_WORKER_MAX: "4", CELL_CONCURRENCY_DEFAULT: "3" } });
  assert.equal(vd.declared, 3);
  assert.equal(vd.source, "deployment");
  const vdef = buildConcurrencyView({ fleetId: "f", id: "m" }, {}, { records: [], env: { TASK_WORKER_MAX: "4" } });
  assert.equal(vdef.declared, 1);
  assert.equal(vdef.source, "default");
});

test("持有与排队来自真实记录，且只数本岗位", () => {
  const records = [rec("running"), rec("running"), rec("queued"), rec("running", "f", "other")];
  const v = buildConcurrencyView({ fleetId: "f", id: "m", concurrency: 3 }, {}, { records, env: { TASK_WORKER_MAX: "4" } });
  assert.equal(v.held, 2);
  assert.equal(v.queued, 1);
});

test("天花板不可读时给 unknown，绝不给 0 或 1", () => {
  const env = { get TASK_WORKER_MAX() { throw new Error("probe down"); } };
  const v = buildConcurrencyView({ fleetId: "f", id: "m", concurrency: 3 }, {}, { records: [], env });
  assert.equal(v.ceiling.unknown, true);
  assert.equal(v.effective, null);
  assert.match(v.ceiling.reason, /probe down/);
  assert.notEqual(v.effective, 0);
});

// ── Task 6.1: default byte-identical ────────────────────────────────────────
test("全链无声明 ⇒ effective=1、source=default、workbench off", () => {
  const v = buildConcurrencyView({ fleetId: "f", id: "m" }, {}, { records: [], env: { TASK_WORKER_MAX: "4" } });
  assert.equal(v.declared, 1);
  assert.equal(v.effective, 1);
  assert.equal(v.source, "default");
  assert.equal(v.workbench, "off");
});

// ── Task 6.6: parallel must NOT widen same-job coalescing ───────────────────
// The pool's role gate limits how many DISTINCT runs of a post can proceed; the
// coalescing rule (one pending round per job) lives in the engine and is
// untouched. This pins the seam: effectiveConcurrencyFor never returns below 1
// and the gate is a cap, not a fan-out.
const poolSrc = fs.readFileSync(path.join(repoRoot, "server/worker-slots.js"), "utf8");
test("6.6 角色闸是上限而不是扇出：placeable 里只有 >= 判定，没有复制任务", () => {
  assert.match(poolSrc, /roleInFlight\(fleetId, memberId\) >= eff/);
  // No line in the pool clones a task id into the queue (that would be fan-out).
  assert.equal(/waiting\.push\([^)]*\bid\b[^)]*\);\s*waiting\.push/.test(poolSrc), false);
});

// ── Task 6.8 (contract half): two runs never share a workbench address ──────
// The physical workbench is fleet-run-workbench's; here we pin that the pool
// asks for one per run (the seam exists and is per-task, not per-pool).
test("6.8 工作台 cwd 是按运行取的，不是池级常量", () => {
  assert.match(poolSrc, /resolveWorkbenchCwdFor\(task, ctx\)/);
  assert.match(poolSrc, /const workbenchCwd = resolveWorkbenchCwdFor/);
});
