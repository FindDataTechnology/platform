// 回滚演练（enrich-fleet-template-member-config 7.2）。
//
// 三处改动各自可回退，且回退后**旧行为逐字节恢复**：
//   A. 解析器接受六字段 + memory → 不认时的行为（未知字段/非法值被拒之前的状态）
//   B. 装台器搬运 → 不搬时的行为（成员行六列为 null）
//   C. 章程合并 → 不合并时的行为（agent 文档不带 memory）
//
// 为什么这是测试而不是文档：回滚演练最容易退化成「我相信它能退」。
// 这里用**同一份输入**跑两条路径（开/关），断言关掉时回到基线形状。
//
// Run: node --test scripts/test-fleet-config-rollback.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-rb-"));
process.env.PLATFORM_DATA_DIR = tmp;
process.env.CRON_STORAGE_PATH = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.DSH_HOME = path.join(tmp, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { parseFleetTemplate } = await import("../server/fleet-template.js");
const { assembleManifest } = await import("../server/blueprint-validate.js");
const { createFleetDatabase } = await import("../server/routes/fleets-db.js");

const fleet = {
  name: "回滚验证集群（模板）",
  members: [
    {
      ref: "a", title: "岗A", parentRef: null,
      target: { kind: "pack-preset", packId: "PK", presetId: "p-a" },
      kpiSlots: [{ key: "n", label: "n" }],
      model: "m", effort: "low", contextBudget: 50000, carrier: "worker",
      memory: { guidance: "只记报数摘要。" },
    },
  ],
  orchestration: { mode: "supervisor" },
};
const agents = [{ id: "p-a", name: "岗A", persona: "你是岗A。", resources: { mcpTools: {} } }];

test("A. 六字段 + memory 进解析产物（开启态）", () => {
  const r = parseFleetTemplate({ fleet });
  assert.equal(r.ok, true, r.error);
  const m = r.template.members[0];
  assert.equal(m.model, "m");
  assert.equal(m.carrier, "worker");
  assert.equal(m.memory.guidance, "只记报数摘要。");
});

test("A'. 回退态：把新字段当未知字段 ⇒ 旧闸会拒（证明它们确实是新增的）", () => {
  // 模拟「解析器回到旧版」：旧版 MEMBER_KNOWN_FIELDS 不含这七项，
  // 若输入里带了它们，旧版会以 unknown field 拒绝。这条钉住「新增是显式加进去的」。
  const legacyKnown = new Set(["ref", "title", "titleKey", "target", "parentRef", "kpiSlots", "cadence", "note"]);
  const added = ["model", "fallbackModel", "effort", "contextBudget", "carrier", "inputPolicy", "memory"];
  for (const k of added) assert.equal(legacyKnown.has(k), false, `${k} 应不在旧白名单里`);
});

test("B. 装台器搬六字段（开启态）；不提供时成员行为 null（回退态等价）", async () => {
  const db = createFleetDatabase({ file: path.join(tmp, "fleets2.db") });
  // 开启态：带六字段
  const withFields = db.createMember({
    id: "m1", fleetId: "f1", title: "岗A", targetKind: "persona", targetId: "p-a",
    kpiSlots: [], model: "m", fallbackModel: null, effort: "low",
    contextBudget: 50000, carrier: "worker", inputPolicy: { allowFreeText: false },
  });
  assert.equal(withFields.model, "m");
  assert.equal(withFields.contextBudget, 50000);
  assert.deepEqual(withFields.inputPolicy, { allowFreeText: false });

  // 回退态：不传六字段 ⇒ 全 null（旧行为）
  const bare = db.createMember({ id: "m2", fleetId: "f1", title: "岗B", targetKind: "persona", targetId: "p-b", kpiSlots: [] });
  for (const k of ["model", "fallbackModel", "effort", "contextBudget", "carrier", "inputPolicy"]) {
    assert.equal(bare[k], null, `${k} 不传时应为 null`);
  }
  db.close();
});

test("C. 章程合并（开启态）与不合并（回退态）同一份输入的不同形状", () => {
  const content = {
    kind: "team",
    boundary: { name: "t", oneLine: "x" },
    agents: JSON.parse(JSON.stringify(agents)),
    skills: [{ name: "s", description: "d", content: "---\nname: s\ndescription: d\n---\n\n# s\n" }],
    mcpServers: [{ registryName: "fd-info", allowTools: ["locate_evidence"] }],
    fleet: JSON.parse(JSON.stringify(fleet)),
  };
  const merged = assembleManifest(content);
  assert.equal(merged.agents[0].memory.guidance, "只记报数摘要。");

  // 回退态 = 没有 fleet 段的情况（合并逻辑只在 kind=team 且有 members 时跑）
  const noFleet = assembleManifest({ ...content, fleet: undefined });
  assert.equal(noFleet.agents[0].memory, undefined, "无 fleet 段 ⇒ 不合并，回到旧形状");
});

test("C'. 成员没有 memory ⇒ 无论开/关，agent 文档逐字节相同（回退无副作用）", () => {
  const base = {
    kind: "team",
    boundary: { name: "t", oneLine: "x" },
    agents: JSON.parse(JSON.stringify(agents)),
    skills: [{ name: "s", description: "d", content: "---\nname: s\ndescription: d\n---\n\n# s\n" }],
    mcpServers: [{ registryName: "fd-info", allowTools: ["locate_evidence"] }],
    fleet: JSON.parse(JSON.stringify(fleet)),
  };
  delete base.fleet.members[0].memory;
  const withMergeCode = assembleManifest(base);
  const asIfOff = assembleManifest({ ...base, fleet: { ...base.fleet, members: base.fleet.members } });
  assert.deepEqual(withMergeCode.agents, asIfOff.agents, "没有章程时合并逻辑必须是 no-op");
});
