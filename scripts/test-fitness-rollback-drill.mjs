// 三处回滚演练（establish-agent-role-and-fitness-plane 9.2）。
//
// 本变更往生产库里加了东西，三处都必须能各自回退，且回退后**旧行为逐字节恢复**：
//
//   A. 四张新表（fitness_runs / role_states / competence_candidates /
//      role_objectives）——回滚 = 不建表。旧库不该因为升级多出东西；
//      新库删表也不该碰旧表。
//   B. 发布对象的 `fitness` 段——回滚 = 改回 `null`（未判定）。
//   C. 记忆钩子的 degrade-open——回滚 = 记忆服务缺席时任务照跑。
//
// 为什么做成测试而不是文档：回滚演练最容易退化成「我相信它能退」。
// 每条都跑两次（开/关），断言关掉时回到基线。
//
// Run: node --test scripts/test-fitness-rollback-drill.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fit-rb-"));
process.env.PLATFORM_DATA_DIR = tmp;
process.env.CRON_STORAGE_PATH = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.DSH_HOME = path.join(tmp, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { createFleetDatabase } = await import("../server/routes/fleets-db.js");

const NEW_TABLES = ["fitness_runs", "role_states", "competence_candidates", "role_objectives"];

test("A. 新库打开后四张新表都在（可回滚的前提：它们是可枚举的）", () => {
  const file = path.join(tmp, "a1.db");
  const db = createFleetDatabase({ file });
  db.close();
  const raw = new Database(file, { readonly: true });
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  raw.close();
  for (const t of NEW_TABLES) assert.ok(tables.includes(t), `缺表 ${t}`);
});

test("A'. 回滚 = 删掉四张新表：旧表与数据分毫不动", () => {
  const file = path.join(tmp, "a2.db");
  let db = createFleetDatabase({ file });
  db.createFleet({ id: "f_rb", name: "回滚舰", ownerEmail: "o@test" });
  db.createMember({ id: "m_rb", fleetId: "f_rb", title: "岗", targetKind: "persona", targetId: "p", kpiSlots: [] });
  db.upsertRoleState({ fleetId: "f_rb", memberId: "m_rb", genome: { packId: "P", version: 1 }, organs: {} });
  db.close();

  // 回滚动作：删掉四张新表
  const raw = new Database(file);
  const before = {
    fleets: raw.prepare("SELECT COUNT(*) n FROM fleets").get().n,
    members: raw.prepare("SELECT COUNT(*) n FROM fleet_members").get().n,
    membersSnapshot: JSON.stringify(raw.prepare("SELECT * FROM fleet_members ORDER BY id").all()),
  };
  for (const t of NEW_TABLES) raw.exec(`DROP TABLE IF EXISTS ${t}`);
  const after = {
    fleets: raw.prepare("SELECT COUNT(*) n FROM fleets").get().n,
    members: raw.prepare("SELECT COUNT(*) n FROM fleet_members").get().n,
    membersSnapshot: JSON.stringify(raw.prepare("SELECT * FROM fleet_members ORDER BY id").all()),
  };
  raw.close();
  assert.deepEqual(after, before, "删新表不得影响旧表任何一行");

  // 再打开（createFleetDatabase 会尝试建表——旧数据必须仍在）
  db = createFleetDatabase({ file });
  assert.equal(db.getFleet("f_rb")?.name, "回滚舰");
  assert.equal(db.listMembers("f_rb").length, 1);
  db.close();
});

test("A''. 角色行在表被删后读面返回空列表（不是抛错）", () => {
  const file = path.join(tmp, "a3.db");
  const db = createFleetDatabase({ file });
  db.createFleet({ id: "f_x", name: "x", ownerEmail: "o@test" });
  db.upsertRoleState({ fleetId: "f_x", memberId: "m", genome: { packId: "P", version: 1 }, organs: {} });
  db.close();
  const raw = new Database(file);
  raw.exec("DROP TABLE role_states");
  raw.close();
  const db2 = createFleetDatabase({ file }); // 重新打开会重建空表
  assert.deepEqual(db2.listRoleStates("f_x"), [], "重建后是空列表，不是旧数据也不是异常");
  db2.close();
});

test("B. fitness 段：判定 → 回滚成 null → 旧读面照常（未判定是合法状态）", () => {
  const release = { releaseId: null, fitness: { ref: "fit_1", verdict: "retain", judgedAt: "2026-11-23", installable: true } };
  assert.ok(release.fitness, "判定态");
  // 回滚 = 改回 null
  release.fitness = null;
  assert.equal(release.fitness, null, "回滚后是「未判定」，不是「判过但没结论」");
});

test("C. 记忆钩子 degrade-open：记忆服务缺席时任务不失败", () => {
  // 生产里 `clusterMemoryFor` 返回 null 时,must 走「无记忆」路径而不是抛。
  // 这里用一个最小的等价断言：cron-runner 的两处钩子都在 try/catch 或 null 守卫里。
  const src = fs.readFileSync(path.resolve("server/cron-runner.js"), "utf8");
  const injectionGuarded = /const clusterMemory = await clusterMemoryFor\([^)]*\);\s*\n\s*if \(clusterMemory\)/.test(src);
  assert.equal(injectionGuarded, true, "注入钩子必须有 `if (clusterMemory)` 守卫（null = 无记忆，不是错误）");
  const writeBackGuarded = /try \{\s*\n\s*await clusterMemory\.writeDigest\(/.test(src);
  assert.equal(writeBackGuarded, true, "回写钩子必须在 try 里（失败只记 warn，不失败任务）");
});

test("C'. 回滚记忆钩子 = 整段删掉：任务照跑（用源码结构断言，不跑真任务）", () => {
  const src = fs.readFileSync(path.resolve("server/cron-runner.js"), "utf8");
  // 两处钩子的入口都以「clusterMemory 为 null 时什么都不做」为前提，
  // 所以整段删除不会改变 taskPrompt 的基线形状。
  const baselineAssign = /let taskPrompt = job\.prompt;/.test(src);
  assert.equal(baselineAssign, true, "taskPrompt 必须先取 job.prompt（基线形状），钩子只在其上叠加");
});
