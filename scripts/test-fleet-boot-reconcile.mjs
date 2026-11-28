// 启动期作业自愈（fix-fleet-boot-reconcile）。
//
// 实测 2026-11-13：给「个人幕僚团」建了常务岗（成员行 cadence=20 * * * *、
// 委托策略 deputyMemberId 已生效），读面一切正常，但**它永远不会跑**——
// 因为没有对应的 schedule 作业，而 reconcile 只在两处被调用：
//   ① 写舰队的路由（建/改/归档成员）
//   ② catalog onChange（persona 增减）
// 于是「进程停机期间被创建 / 由带外写入创建的岗位」在重启后依旧没有作业，
// 静默地不跑。这类岗位在面板上看起来完全正常，只是永远不出现回合。
//
// 判据：boot 时对全部舰队做一次收敛，就能把「有节奏、无作业」补上；且第二次
// 跑必须零动作（幂等），否则每次重启都会重写作业。

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-boot-reconcile-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");

const db0 = await import("../db.js");
await db0.initDb();
const chatHistory = await import("../chat-history.js");
await chatHistory.initChatHistory();
const engine = await import("../task-engine.js");
await engine.initTaskEngine({ broadcast: () => {}, runTurn: async () => ({ ok: true }), isBusy: () => false });

const fleetDb = await import("../server/routes/fleets-db.js");
const { reconcileAllFleets } = await import("../server/fleet-reconcile.js");
const cron = await import("../cron.js");
const { bootReconcileFleets } = await import("../server/fleet-boot-reconcile.js");

test.after(() => {
  // Armed node-schedule handles (hourly cadence) keep the event loop alive past
  // the last test — cancel them or the runner never exits.
  cron.shutdown?.();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const HOURLY = { cron: "0 * * * *", tz: "Asia/Shanghai", enabled: true, promptTemplate: "巡视并报数 {{fleetContext}}" };
const rosterFn = (id) => `r-${id}`;
const makeResolver = (alive) => (member) => ({ alive: alive.has(member.targetId), clusterName: null });

let seq = 0;
function fixtureFleet() {
  seq += 1;
  const now = Date.now();
  return fleetDb.getFleetDatabase().createFleet({
    id: `fl_boot_${now}_${seq}`,
    name: `启动收敛验 ${seq}`,
    ownerEmail: "owner@example.com",
    state: "active",
  });
}

function fixtureMember(fleetId, { cadence = HOURLY, target = "persona-a" } = {}) {
  const now = Date.now();
  seq += 1;
  return fleetDb.getFleetDatabase().createMember({
    id: `m_boot_${now}_${seq}`,
    fleetId,
    title: `岗 ${seq}`,
    targetKind: "persona",
    targetId: target,
    kpiSlots: [],
    cadence,
  });
}

const fleetJobs = (fleetId) =>
  cron.listJobs().filter((j) => j?.sourceTag?.fleetId === fleetId && j.trigger === "schedule");

// ── 1. 有节奏、无作业 → 补上 ─────────────────────────────────────────────────

test("boot 收敛给「有节奏但没有作业」的岗位补出作业", async () => {
  const fleet = fixtureFleet();
  const member = fixtureMember(fleet.id);
  assert.equal(fleetJobs(fleet.id).length, 0, "前置：建岗时不该有作业（模拟带外写入）");

  const out = await bootReconcileFleets({
    db: fleetDb.getFleetDatabase(),
    cronApi: cron,
    resolveTarget: makeResolver(new Set(["persona-a"])),
    rosterPresetId: rosterFn,
  });

  const jobs = fleetJobs(fleet.id);
  assert.equal(jobs.length, 1, "启动收敛后该岗有作业了");
  assert.equal(jobs[0].sourceTag.memberId, member.id);
  assert.ok(out.some((r) => r.fleetId === fleet.id && r.created.length === 1), "结果里点名新建");
});

// ── 2. 幂等：第二次零动作 ───────────────────────────────────────────────────

test("启动收敛是幂等的：再跑一次不动任何作业", async () => {
  const fleet = fixtureFleet();
  fixtureMember(fleet.id);
  const args = {
    db: fleetDb.getFleetDatabase(),
    cronApi: cron,
    resolveTarget: makeResolver(new Set(["persona-a"])),
    rosterPresetId: rosterFn,
  };
  await bootReconcileFleets(args);
  const first = fleetJobs(fleet.id).map((j) => j.id);
  const out = await bootReconcileFleets(args);
  const second = fleetJobs(fleet.id).map((j) => j.id);
  assert.deepEqual(second, first, "作业 id 不变（没有重建）");
  const mine = out.find((r) => r.fleetId === fleet.id);
  assert.deepEqual(
    { created: mine.created, updated: mine.updated, removed: mine.removed },
    { created: [], updated: [], removed: [] },
    "第二次收敛零动作",
  );
});

// ── 3. 坏舰队不拖垮整轮 ─────────────────────────────────────────────────────

test("某支舰队抛错不影响其它舰队收敛", async () => {
  const good = fixtureFleet();
  fixtureMember(good.id);
  const bad = fixtureFleet();
  fixtureMember(bad.id);

  const db = fleetDb.getFleetDatabase();
  const realGetFleet = db.getFleet.bind(db);
  db.getFleet = (id) => {
    if (id === bad.id) throw new Error("boom");
    return realGetFleet(id);
  };
  try {
    const out = await bootReconcileFleets({
      db,
      cronApi: cron,
      resolveTarget: makeResolver(new Set(["persona-a"])),
      rosterPresetId: rosterFn,
    });
    assert.equal(fleetJobs(good.id).length, 1, "好舰队照常收敛");
    assert.ok(out.some((r) => r.fleetId === bad.id && r.error), "坏舰队被记成一条 error，而不是整轮失败");
  } finally {
    db.getFleet = realGetFleet;
  }
});

// ── 4. 已归档舰队不物化（archive is stop-and-keep） ─────────────────────────

test("已归档舰队不会被启动收敛重新物化作业", async () => {
  const fleet = fixtureFleet();
  fixtureMember(fleet.id);
  fleetDb.getFleetDatabase().updateFleet(fleet.id, { state: "archived" });
  await bootReconcileFleets({
    db: fleetDb.getFleetDatabase(),
    cronApi: cron,
    resolveTarget: makeResolver(new Set(["persona-a"])),
    rosterPresetId: rosterFn,
  });
  assert.equal(fleetJobs(fleet.id).length, 0, "归档是 stop-and-keep");
});

// ── 5. engine 未就绪时不硬来（启动顺序保护） ────────────────────────────────

test("engine 未初始化时跳过而不是抛错", async () => {
  const out = await bootReconcileFleets({
    db: fleetDb.getFleetDatabase(),
    cronApi: { listJobs: () => [], addJob: async () => { throw new Error("must not be called"); } },
    resolveTarget: makeResolver(new Set()),
    rosterPresetId: rosterFn,
    isEngineReady: () => false,
  });
  assert.deepEqual(out, [], "未就绪时零动作、零异常");
});

// reconcileAllFleets 本身仍可用（本轮不改它的语义）
test("reconcileAllFleets 保持原语义", async () => {
  const fleet = fixtureFleet();
  fixtureMember(fleet.id);
  const out = await reconcileAllFleets({
    db: fleetDb.getFleetDatabase(),
    cronApi: cron,
    resolveTarget: makeResolver(new Set(["persona-a"])),
    rosterPresetId: rosterFn,
  });
  assert.ok(Array.isArray(out));
  assert.equal(fleetJobs(fleet.id).length, 1);
});
