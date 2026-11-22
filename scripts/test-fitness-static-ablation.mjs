// 静态消融（establish-agent-role-and-fitness-plane 2.1 / 2.2）。
//
// 钉三件事，每件都对应一种「看着像结论、其实证据不足」的形态：
//   1. 缺字段 ≠ 判红：`objective` 是本变更新增的声明，存量模板没有它时结论是
//      keep-unproven（有边有 KPI，只是没有目标声明），不是 candidate-*。
//   2. trigger 边不算读者：它是 cron 的形状，不是「谁用它的产出」。
//   3. 静态结论必须自带 evidenceLevel 与 missing，使下游知道它只到哪一步。
//
// Run: node --test scripts/test-fitness-static-ablation.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { judgeStatic, loadTemplate, exitCodeFor, EXIT, selfTest } = await import("./fitness-static-ablation.mjs");

test("自证六臂全过（孤儿/健康/有目标/可合并/只有 trigger/零岗）", () => {
  assert.equal(selfTest(), 0);
});

test("缺 objective 时降级为 keep-unproven，而不是判红", () => {
  const r = judgeStatic({
    members: [{ ref: "a", kpiSlots: [{ key: "n" }] }, { ref: "b", kpiSlots: [{ key: "m" }] }],
    orchestration: { edges: [{ kind: "handoff", from: "a", to: "b" }] },
  });
  assert.equal(r.posts.find((p) => p.ref === "a").verdict, "keep-unproven");
  assert.equal(exitCodeFor(r), EXIT.KEEP);
});

test("静态结论带 evidenceLevel 与 missing，下游知道证据只到静态", () => {
  const r = judgeStatic({ members: [{ ref: "a", kpiSlots: [] }], orchestration: { edges: [] } });
  assert.equal(r.evidenceLevel, "static");
  assert.equal(r.posts[0].evidenceLevel, "static");
  assert.ok(r.posts[0].missing.some((m) => m.includes("运行期")));
});

test("从 manifest 与 template 两种形状都读得出", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "static-ablation-"));
  const tplFile = path.join(tmp, "template.json");
  fs.writeFileSync(tplFile, JSON.stringify({
    name: "t",
    agents: [],
    fleet: { members: [{ ref: "only", kpiSlots: [{ key: "n" }] }], orchestration: { edges: [] } },
  }));
  const tpl = loadTemplate(tplFile);
  assert.equal(tpl.source, "manifest");
  assert.equal(judgeStatic(tpl).posts.length, 1);

  const plain = path.join(tmp, "plain.json");
  fs.writeFileSync(plain, JSON.stringify({ members: [{ ref: "x", kpiSlots: [] }], orchestration: { edges: [] } }));
  assert.equal(loadTemplate(plain).source, "template");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("既无 fleet 也无 members 的文件判不出（roles 包不是团队模板）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "static-ablation-"));
  const f = path.join(tmp, "roles.json");
  fs.writeFileSync(f, JSON.stringify({ name: "roles", agents: [{ id: "a" }], skills: [] }));
  assert.throws(() => loadTemplate(f), /no fleet members/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
