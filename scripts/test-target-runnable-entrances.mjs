// fix-handoff-to-dead-post: every entrance that mints a turn asks the same
// question the dispatch guard asks.
//
// The dispatch lane got this guard first (fix-dispatch-to-parked-post). Then the
// 4.1 inventory of all nine task-creation call sites found four more entrances
// that never asked, and the ledger proved one of them was already firing:
//   source=manual, edge_kind=handoff, "Unknown agent preset: policy-brief"
//   9 rows, last 2026-11-14T01:43:39Z (cell 1da519d4c1c0bf89)
// The fleet layer had parked that post, but `paused` only stops cadence fires —
// the handoff edge minted a turn anyway and it failed from the first millisecond.
//
// What this file pins, per entrance: a dead target mints NOTHING and leaves a
// readable row; a live target behaves exactly as before; the two deliberate
// exemptions (tool, cluster) are not swept up by the new guard.
//
// Run: node --test scripts/test-target-runnable-entrances.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "target-runnable-entrances-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = `${tmpRoot}/app.db`;
process.env.PLATFORM_DATA_DIR = tmpRoot;

const { targetRunnable } = await import("../server/fleet-target-runnable.js");
const { dispatchTargetRunnable } = await import("../server/routes/fleets.js");
const { igniteFleetEdges } = await import("../server/fleet-handoffs.js");
const { createWakeTask, recordWakeRefusal } = await import("../server/fleet-event-wake.js");

const deadResolve = () => ({ alive: false, label: "policy-brief", clusterName: null });
const liveResolve = () => ({ alive: true, label: "幕僚长", clusterName: null });

// ── 1. 判据本体（一份，五处共用） ───────────────────────────────────────────

test("判据：死目标被拒，文案点名岗位、目标与修法", () => {
  const r = targetRunnable({ title: "简报岗", targetKind: "persona", targetId: "policy-brief" }, deadResolve);
  assert.equal(r.ok, false);
  assert.match(r.error, /简报岗/);
  assert.match(r.error, /policy-brief/);
  assert.match(r.error, /restaff/);
});

test("判据：活目标放行；无 target 拒绝而不是抛", () => {
  assert.deepEqual(targetRunnable({ title: "幕僚长", targetKind: "persona", targetId: "chief" }, liveResolve), { ok: true });
  assert.equal(targetRunnable(null, liveResolve).ok, false);
});

test("判据：工具岗/集群岗豁免（沿用派发面的既有决定）", () => {
  assert.deepEqual(targetRunnable({ title: "盯梢岗", targetKind: "tool", targetId: "websearch::web_search" }, deadResolve), { ok: true });
  assert.deepEqual(targetRunnable({ title: "集群岗", targetKind: "cluster", targetId: "c1" }, deadResolve), { ok: true });
});

test("判据：缺 resolver 当场抛——静默放行正是这次要修的病", () => {
  assert.throws(() => targetRunnable({ title: "简报岗", targetKind: "persona", targetId: "policy-brief" }, undefined), /resolver/);
});

test("派发薄壳与本体同源：搬家没搬坏", () => {
  const a = dispatchTargetRunnable({ title: "简报岗", targetKind: "persona", targetId: "policy-brief" }, deadResolve);
  const b = targetRunnable({ title: "简报岗", targetKind: "persona", targetId: "policy-brief" }, deadResolve);
  assert.deepEqual(a, b);
});

// ── 2. 接棒边（live 失败 9 条的那条） ───────────────────────────────────────

function handoffHarness({ targetKind = "persona", targetId = "policy-brief" } = {}) {
  const rows = [];
  const tasks = [];
  const member = { id: "m-brief", fleetId: "f1", title: "简报岗", targetKind, targetId };
  const upstream = { id: "m-chief", fleetId: "f1", title: "幕僚长", targetKind: "persona", targetId: "chief" };
  const db = {
    getFleet: () => ({
      id: "f1",
      orchestration: {
        edges: [{ from: "m-chief", to: "m-brief", kind: "handoff" }],
        constraints: { maxChainDepth: 3, budgetPerEdgeMin: 10 },
        runBudget: null,
      },
    }),
    getMember: (id) => (id === "m-brief" ? member : id === "m-chief" ? upstream : null),
    appendTurnEvent: (r) => rows.push(r),
    stopRun: () => {},
  };
  const engine = {
    createManualTask: (spec) => {
      const t = { id: `t${tasks.length + 1}`, ...spec };
      tasks.push(t);
      return t;
    },
    allRecords: () => tasks,
  };
  const job = { origin: { fleet: { fleetId: "f1", memberId: "m-chief", depth: 0 } }, sessionId: null };
  return { db, engine, job, rows, tasks };
}

test("接棒：指向死岗位的跳不造任务，并留一条 runtime_not_ready 行", async () => {
  const h = handoffHarness();
  const out = { ok: true, text: "上游完成" };
  await igniteFleetEdges({ ...h, out, resolveTarget: deadResolve });
  assert.equal(h.tasks.length, 0, "死目标的接棒跳不得创建任何任务");
  const row = h.rows.find((r) => r.errorKind === "runtime_not_ready");
  assert.ok(row, "必须留下失败行——否则「为什么没接棒」无从可读");
  assert.match(row.error, /简报岗|policy-brief/);
  assert.equal(row.status, "failed");
});

test("接棒：活目标照常造任务（新守卫不误拒）", async () => {
  const h = handoffHarness();
  await igniteFleetEdges({ ...h, out: { ok: true, text: "上游完成" }, resolveTarget: liveResolve });
  assert.equal(h.tasks.length, 1, "活目标的接棒跳必须照常");
  assert.equal(h.rows.filter((r) => r.errorKind === "runtime_not_ready").length, 0);
});

// ── 3. 事件唤醒 ────────────────────────────────────────────────────────────

const wakeFixture = (targetKind = "persona", targetId = "policy-brief") => ({
  fleet: { id: "f1" },
  target: { id: "m-brief", fleetId: "f1", title: "简报岗", targetKind, targetId },
});

test("唤醒：死岗位返回拒绝而不是任务", () => {
  const made = [];
  const engine = { createManualTask: (s) => (made.push(s), { id: "t1", ...s }) };
  const r = createWakeTask(engine, (id) => id, deadResolve, {
    ...wakeFixture(),
    source: "bot:b1",
    senderName: "张三",
    chatKey: "c1",
    text: "在吗",
    mandate: { trigger: { botId: "b1" }, policyVersion: 1 },
  });
  assert.ok(r?.refused, "死岗位必须被拒");
  assert.match(r.refused, /policy-brief/);
  assert.equal(made.length, 0, "拒绝时不得创建任务");
});

test("唤醒：活岗位照常造任务", () => {
  const made = [];
  const engine = { createManualTask: (s) => (made.push(s), { id: "t1", ...s }) };
  createWakeTask(engine, (id) => id, liveResolve, {
    ...wakeFixture("persona", "chief"),
    source: "bot:b1",
    senderName: "张三",
    chatKey: "c1",
    text: "在吗",
    mandate: { trigger: { botId: "b1" }, policyVersion: 1 },
  });
  assert.equal(made.length, 1);
  assert.equal(made[0].persona, "chief");
});

test("唤醒：拒绝时那条账本行由 recordWakeRefusal 写，两处调用共用", () => {
  const rows = [];
  const db = { appendTurnEvent: (r) => rows.push(r) };
  const { fleet, target } = wakeFixture();
  recordWakeRefusal(db, { fleet, target }, "post '简报岗' is parked: its target persona/policy-brief no longer exists", 1700000000000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].errorKind, "runtime_not_ready");
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].memberId, "m-brief");
  assert.equal(rows[0].fleetId, "f1");
});
