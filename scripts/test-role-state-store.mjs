// 角色状态 CRUD + 采纳/回滚（establish-agent-role-and-fitness-plane 5.1 / 5.2 前置）。
//
// 这一层此前**完全不存在**：`role_states` 表在 1.1 建了，但没有任何读写入口。
// 「表建好了不等于在记录」——五张表里三张是死表，这是本仓的原话。
//
// 钉四件事：
//   1. 一个岗位一行（UNIQUE fleet_id+member_id），upsert 不是 insert
//   2. 基因组是**引用**：升版改这一行，不新增行
//   3. 采纳/回滚是两个显式动作，`before` 值可回滚
//   4. 读面区分「没有角色行」与「有行但器官为空」
//
// Run: node --test scripts/test-role-state-store.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "role-store-"));
process.env.PLATFORM_DATA_DIR = tmp;
process.env.CRON_STORAGE_PATH = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.DSH_HOME = path.join(tmp, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
const { adoptionTransition } = await import("../lib/agent-role.js");

const fresh = () => {
  const db = createFleetDatabase({ file: path.join(tmp, `f-${Math.random().toString(36).slice(2)}.db`) });
  db.createFleet({ id: "f1", name: "角色舰", ownerEmail: "o@test" });
  return db;
};

test("没有角色行 ⇒ getRoleState 返回 null（不是空对象）", () => {
  const db = fresh();
  assert.equal(db.getRoleState("f1", "m1"), null);
  assert.deepEqual(db.listRoleStates("f1"), []);
  db.close();
});

test("upsert 一个岗位只留一行；再次 upsert 是改不是加", () => {
  const db = fresh();
  db.upsertRoleState({ fleetId: "f1", memberId: "m1", genome: { packId: "P", version: 1 }, organs: { charter: "x" } });
  db.upsertRoleState({ fleetId: "f1", memberId: "m1", genome: { packId: "P", version: 2 }, organs: { charter: "y" } });
  const rows = db.listRoleStates("f1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].genome.version, 2);
  assert.deepEqual(rows[0].organs, { charter: "y" });
  assert.ok(rows[0].genomeAdoptedAt, "采纳时间必须落");
  db.close();
});

test("基因组是引用：采纳升版后再回滚，版本回到旧值且 before 可查", () => {
  const db = fresh();
  db.upsertRoleState({ fleetId: "f1", memberId: "m1", genome: { packId: "P", version: 3 }, organs: {} });
  const back = adoptionTransition({ current: { packId: "P", version: 3 }, target: { packId: "P", version: 4 } });
  assert.equal(back.ok, true);
  db.upsertRoleState({ fleetId: "f1", memberId: "m1", genome: back.genome, organs: {} });
  assert.equal(db.getRoleState("f1", "m1").genome.version, 4);
  // 回滚 = 把 before 写回去
  db.upsertRoleState({ fleetId: "f1", memberId: "m1", genome: back.before, organs: {} });
  assert.equal(db.getRoleState("f1", "m1").genome.version, 3);
  db.close();
});

test("换基因组被拒（那是重铸不是采纳）⇒ 状态不动", () => {
  const db = fresh();
  db.upsertRoleState({ fleetId: "f1", memberId: "m1", genome: { packId: "P", version: 1 }, organs: {} });
  const bad = adoptionTransition({ current: { packId: "P", version: 1 }, target: { packId: "Q", version: 1 } });
  assert.equal(bad.ok, false);
  assert.equal(db.getRoleState("f1", "m1").genome.packId, "P", "被拒的采纳不得改动角色");
  db.close();
});

test("批准前零变化：不调用 upsert 时，逐字段不变（5.2 的验证形状）", () => {
  const db = fresh();
  const before = db.upsertRoleState({
    fleetId: "f1", memberId: "m1",
    genome: { packId: "P", version: 1 },
    organs: { charter: "原章程", hands: { "fd-info": ["get_item"] } },
    status: "producing", statusBasis: "有 3 个成功回合",
  });
  // 模拟「提案已提交、尚未批准」：不写库
  const snap = JSON.stringify(db.getRoleState("f1", "m1"));
  assert.equal(JSON.stringify(before), snap);
  const after = db.getRoleState("f1", "m1");
  assert.deepEqual(after.organs, { charter: "原章程", hands: { "fd-info": ["get_item"] } });
  assert.equal(after.status, "producing");
  db.close();
});

test("删除角色行后可再建（回滚到「没有角色」也是一种状态）", () => {
  const db = fresh();
  db.upsertRoleState({ fleetId: "f1", memberId: "m1", genome: { packId: "P", version: 1 }, organs: {} });
  assert.equal(db.deleteRoleState("f1", "m1").deleted, 1);
  assert.equal(db.getRoleState("f1", "m1"), null);
  db.close();
});

test("多岗位按 memberId 稳定排序（读面要可复算）", () => {
  const db = fresh();
  for (const m of ["mC", "mA", "mB"]) db.upsertRoleState({ fleetId: "f1", memberId: m, genome: { packId: "P", version: 1 }, organs: {} });
  assert.deepEqual(db.listRoleStates("f1").map((r) => r.memberId), ["mA", "mB", "mC"]);
  db.close();
});

test("两个舰队读面都必须带 role：/:id 与 /:id/cockpit（我曾在只挂一个，界面永远读不到）", () => {
  const src = fs.readFileSync(new URL("../server/routes/fleets.js", import.meta.url), "utf8");
  const roleByMemberSites = (src.match(/roleByMember/g) ?? []).length;
  // 两处构造 + 两处使用 = 4 次
  assert.ok(roleByMemberSites >= 4, `roleByMember 只出现 ${roleByMemberSites} 次——两个读面必须都挂 role`);
  // 驾驶舱那条（前端 loadDetail 打的是 /cockpit）
  const cockpitBlock = src.slice(src.indexOf('"/:id/cockpit"'), src.indexOf('"/:id/cockpit"') + 3000);
  assert.match(cockpitBlock, /role: roleByMember\.get/, "cockpit 路由必须给每个岗位挂 role");
});
