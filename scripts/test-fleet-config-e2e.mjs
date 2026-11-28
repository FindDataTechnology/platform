// 团队配置面端到端（enrich-fleet-template-member-config 7.1）。
//
// 这条测的是**三段闭环真的接上了**，不是任何单段的形状：
//   模板声明 → 装台 → live 成员行六字段 → 读面逐字相等 → 章程与 persona 同源
//
// 为什么必须有这一条：本 change 修的正是「声明了但没生效」。三段各自有单测时，
// 中间那一段（provisioner 搬运）漏一个字段仍然全绿——那正是修复前的真实状态。
//
// Run: node --test scripts/test-fleet-config-e2e.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-e2e-"));
process.env.PLATFORM_DATA_DIR = tmp;
process.env.CRON_STORAGE_PATH = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.DSH_HOME = path.join(tmp, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { provisionFleetFromTemplate } = await import("../server/fleet-provisioner.js");

// 一份最小但真实的团队模板：两个岗，六字段齐全 + 各自的章程在 agents[] 里。
const manifest = {
  name: "配置面验证团队",
  category: "fleet",
  agents: [
    { id: "cfg-cheap", name: "轻量岗", persona: "你是轻量岗。收尾必 report_status。", memory: { guidance: "本岗只记报数摘要与失败归因。" } },
    { id: "cfg-heavy", name: "主力岗", persona: "你是主力岗。收尾必 report_status。", memory: { guidance: "本岗记结论、出处与未决项。" } },
  ],
  skills: [{ name: "cfg-skill", description: "样例", content: "---\nname: cfg-skill\ndescription: 样例\n---\n\n# 样例\n" }],
  mcpServers: [{ registryName: "fd-info", allowTools: ["locate_evidence"] }],
  fleet: {
    name: "配置面验证集群（模板）",
    members: [
      {
        ref: "cheap",
        title: "轻量岗",
        parentRef: "heavy",
        target: { kind: "pack-preset", packId: "PK", presetId: "cfg-cheap" },
        kpiSlots: [{ key: "n", label: "数" }],
        cadence: { cron: "0 1 * * *", tz: "Asia/Shanghai", promptTemplate: "巡检并报数 {{fleetContext}}" },
        model: "cheap-model",
        fallbackModel: "cheap-fallback",
        effort: "low",
        contextBudget: 50000,
        carrier: "worker",
        inputPolicy: { allowFreeText: false },
      },
      {
        ref: "heavy",
        title: "主力岗",
        parentRef: null,
        target: { kind: "pack-preset", packId: "PK", presetId: "cfg-heavy" },
        kpiSlots: [{ key: "m", label: "数" }],
        // 第二个岗**什么都不声明**：验证「未声明 = null，不是平台默认」。
      },
    ],
    orchestration: { mode: "supervisor" },
  },
};

test("端到端：模板六字段 → 装台 → live 成员行逐字相等；未声明者为 null", async () => {
  const db = createFleetDatabase({ file: path.join(tmp, "fleets.db") });
  setFleetDatabase(db);
  const out = await provisionFleetFromTemplate({
    packId: "PK",
    version: 1,
    manifest,
    ownerEmail: "o@test",
    deps: {
      db,
      resolveExisting: () => true,
      catalogAgentIds: () => new Set(["cfg-cheap", "cfg-heavy"]),
      reconcile: () => {},
    },
  });
  assert.equal(out.ok, true, JSON.stringify(out));

  const members = db.listMembers(out.fleet.id);
  const cheap = members.find((m) => m.title === "轻量岗");
  const heavy = members.find((m) => m.title === "主力岗");

  // 六个字段：声明了的逐字相等
  assert.equal(cheap.model, "cheap-model");
  assert.equal(cheap.fallbackModel, "cheap-fallback");
  assert.equal(cheap.effort, "low");
  assert.equal(cheap.contextBudget, 50000);
  assert.equal(cheap.carrier, "worker");
  assert.deepEqual(cheap.inputPolicy, { allowFreeText: false });

  // 未声明 = null（六个字段逐个），不是平台默认
  for (const k of ["model", "fallbackModel", "effort", "contextBudget", "carrier", "inputPolicy"]) {
    assert.equal(heavy[k], null, `${k} 未声明应为 null，实际 ${JSON.stringify(heavy[k])}`);
  }
  db.close();
});

test("端到端：章程与 persona 注入同源（读面读的就是 persona 里那一段）", async () => {
  const { catalogEntryPersona } = await import("../dsh-profile.js");
  const cheap = manifest.agents.find((a) => a.id === "cfg-cheap");
  const persona = catalogEntryPersona({ ...cheap, packId: "PK" });
  assert.ok(persona.includes("【记忆章程】本岗只记报数摘要与失败归因。"), "章程必须进 persona 尾段");

  const { memoryCharterForTest } = await import("../server/routes/fleets.js");
  const read = memoryCharterForTest(
    { targetKind: "persona", targetId: "cfg-cheap" },
    { chatAgentEntries: [{ id: "cfg-cheap", memory: cheap.memory }] },
  );
  assert.equal(read, "本岗只记报数摘要与失败归因。", "读面必须读同一份");
  // 两个岗的章程不串
  const other = memoryCharterForTest(
    { targetKind: "persona", targetId: "cfg-heavy" },
    { chatAgentEntries: [{ id: "cfg-heavy", memory: { guidance: "本岗记结论、出处与未决项。" } }] },
  );
  assert.equal(other, "本岗记结论、出处与未决项。");
});
