// Fleet input policy (add-input-request-cards, tasks 3.1-3.4):
//
//   §1 老库升级：两列可空、既有行不受影响、可以清空恢复继承。
//   §2 逐字段继承：member 覆盖 fleet、部分字段继承、两层皆空 = null。
//   §3 每回合配额：同 (session, turn) 第二次提卡被拒；换回合放行。
//   §4 归属：会话 → 最近回合事件 → 岗位 → 舰队；无事件 = 无归属。

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-input-policy-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
// fleets 走独立库（storeDir("data")/fleets.db）：不钉住 data 根，测试会写进
// 仓库的 data/ 目录——第一次跑就是这么污染出来的。
process.env.PLATFORM_DATA_DIR = tmpRoot;

const dbMod = await import("../db.js");
const { getFleetDatabase } = await import("../server/routes/fleets-db.js");
const policy = await import("../server/fleet-input-policy.js");
const core = await import("../server/input-requests.js");

let fdb;
let db;

before(async () => {
  await dbMod.initDb();
  db = dbMod.getDb();
  fdb = getFleetDatabase();
  core.ensureInputRequestSchema(db);
});

function mkFleet(id, inputPolicy = null) {
  const _fleet = fdb.createFleet({ id, name: id, ownerEmail: "owner@example.com" });
  if (inputPolicy !== null) fdb.updateFleet(id, { inputPolicy });
  return fdb.getFleet(id);
}

function mkMember(id, fleetId, inputPolicy = null) {
  const _m = fdb.createMember({
    id,
    fleetId,
    title: id,
    targetKind: "persona",
    targetId: `persona-${id}`,
    kpiSlots: [],
    cadence: null,
  });
  if (inputPolicy !== null) fdb.updateMember(id, { inputPolicy });
  return fdb.getMember(id);
}

test("3.1 两列可空且既有行不受影响", () => {
  const cols = fdb.db.prepare("PRAGMA table_info(fleets)").all().map((c) => c.name);
  assert.ok(cols.includes("input_policy"));
  const mcols = fdb.db.prepare("PRAGMA table_info(fleet_members)").all().map((c) => c.name);
  assert.ok(mcols.includes("input_policy"));

  const fleet = mkFleet("f-null");
  assert.equal(fleet.inputPolicy, null);
  const member = mkMember("m-null", "f-null");
  assert.equal(member.inputPolicy, null);
});

test("3.1b 写读往返 + 清空恢复继承", () => {
  mkFleet("f-write");
  fdb.updateFleet("f-write", { inputPolicy: { onUnattended: "abort", perTurnQuota: 2 } });
  assert.deepEqual(fdb.getFleet("f-write").inputPolicy, { onUnattended: "abort", perTurnQuota: 2 });
  fdb.updateFleet("f-write", { inputPolicy: null });
  assert.equal(fdb.getFleet("f-write").inputPolicy, null);
});

test("3.2 逐字段继承：岗位覆盖舰队，未声明字段继续继承", () => {
  const eff = policy.resolveInputPolicy({
    fleet: { onUnattended: "escalate", perTurnQuota: 3, timeoutSec: 900, allowedTypes: ["form"] },
    member: { onUnattended: "abort" },
  });
  assert.equal(eff.onUnattended, "abort");
  assert.equal(eff.perTurnQuota, 3);
  assert.equal(eff.timeoutSec, 900);
  assert.deepEqual(eff.allowedTypes, ["form"]);
});

test("3.2b 两层皆空 = 无策略（走内核默认）", () => {
  assert.equal(policy.resolveInputPolicy({ fleet: null, member: null }), null);
  assert.equal(policy.resolveInputPolicy({}), null);
  // 非法值被丢弃而不是被"修好"
  assert.equal(policy.resolveInputPolicy({ fleet: { onUnattended: "explode" } }), null);
  assert.equal(policy.parseInputPolicy({ allowedTypes: ["nope"] }), null);
});

test("3.2c 舰队声明、岗位覆盖：会话归属后生效", () => {
  mkFleet("f-attr", { onUnattended: "escalate", perTurnQuota: 5 });
  mkMember("m-attr", "f-attr", { onUnattended: "abort" });
  // 造一条回合事件，让会话归属到这个岗位
  fdb.db.prepare(
    `INSERT INTO member_turn_events (fleet_id, member_id, source, status, started_at, ended_at, session_id)
     VALUES (?, ?, 'cron', 'success', ?, ?, ?)`,
  ).run("f-attr", "m-attr", Date.now() - 1000, Date.now(), "s-fleet-turn");

  const { attribution, policy: eff } = policy.inputPolicyForSession("s-fleet-turn");
  assert.equal(attribution.fleetId, "f-attr");
  assert.equal(attribution.memberId, "m-attr");
  assert.equal(eff.onUnattended, "abort");
  assert.equal(eff.perTurnQuota, 5);
});

test("3.2d 没有回合事件的会话没有归属", () => {
  const { attribution, policy: eff } = policy.inputPolicyForSession("s-not-a-fleet");
  assert.equal(attribution, null);
  assert.equal(eff, null);
});

test("3.3 每回合配额：同回合第二次被拒，换回合放行", () => {
  const now = Date.now();
  core.createInputRequest(db, {
    id: "q-1",
    ownerEmail: "owner@example.com",
    sessionId: "s-quota",
    turnId: "t-1",
    card: { type: "form", title: "t", fields: [{ key: "a", kind: "text" }] },
    now,
  });
  const first = policy.checkPerTurnQuota(db, { sessionId: "s-quota", turnId: "t-1", quota: 1 });
  assert.equal(first.ok, false);
  assert.equal(first.used, 1);

  const nextTurn = policy.checkPerTurnQuota(db, { sessionId: "s-quota", turnId: "t-2", quota: 1 });
  assert.equal(nextTurn.ok, true);
});

test("3.3b 没有 turn id 时按本会话在途数计（已答的不占额）", () => {
  core.createInputRequest(db, {
    id: "q-2",
    ownerEmail: "owner@example.com",
    sessionId: "s-quota2",
    turnId: null,
    card: { type: "form", title: "t", fields: [{ key: "a", kind: "text" }] },
  });
  assert.equal(policy.checkPerTurnQuota(db, { sessionId: "s-quota2", turnId: null, quota: 1 }).ok, false);
  core.answerInputRequest(db, "q-2", { values: { a: "x" }, answeredBy: "owner@example.com" });
  assert.equal(policy.checkPerTurnQuota(db, { sessionId: "s-quota2", turnId: null, quota: 1 }).ok, true);
});

test("3.4 配额为 0 / 未声明 = 不设限", () => {
  assert.equal(policy.checkPerTurnQuota(db, { sessionId: "s-any", turnId: "t", quota: null }).ok, true);
});
