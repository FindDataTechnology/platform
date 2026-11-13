#!/usr/bin/env node
// ── Official business-team content baseline (modernize-official-business-teams) ─
//
// 静态守卫 staging/ 里的 10 支业务团队改版稿（发布前的第二道锁，与发布脚本
// 的断言同源、不联网）：
//   1. 每支团队覆盖全部岗位，与 source-snapshot.json 的岗位集合一一对应
//   2. persona ≥380 字、含【职责边界】+（【输出契约】or【工作纪律】）、含
//      report_status 与诚实纪律句
//   3. 改版前 persona 里声明的 report_status 槽位逐字保留（自动派生，不手抄）
//   4. skills ≥2 且 ASCII 名（发布门字符集）+ 内容 ≥200 字
//   5. mcpServers 只钉 registry-allowtools.json 的真实 registryName + 真实
//      工具名（非空）
//   6. overlay 只碰三个内容桶，结构与身份留给原 manifest
//
//   node --test scripts/test-business-teams-content-baseline.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
// 溯源真值驻 docs/fleet-templates/staging/（原住归档 change 目录，清理即断链——audit P2）
const staging = path.join(root, "docs/fleet-templates/staging");

const snapshot = JSON.parse(fs.readFileSync(path.join(staging, "source-snapshot.json"), "utf8"));
const registryAllow = JSON.parse(fs.readFileSync(path.join(staging, "registry-allowtools.json"), "utf8"));
const teams = fs
  .readdirSync(path.join(staging, "teams"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(staging, "teams", f), "utf8")));

const deriveSlots = (persona) => {
  const out = new Set();
  for (const m of persona.matchAll(/槽位[：: ]+([A-Za-z0-9_/、,， ]+)/g)) {
    for (const tok of m[1].split(/[/、,，\s]+/)) if (/^[a-z][a-z0-9_]{2,}$/.test(tok)) out.add(tok);
  }
  return [...out];
};

test("coverage: every business team present, every post covered, ids exact", () => {
  assert.equal(teams.length, 10, "ten business teams");
  const snapshotIds = Object.keys(snapshot).sort();
  assert.deepEqual(teams.map((t) => t.packId).sort(), snapshotIds, "packIds match the staged snapshot");
  for (const t of teams) {
    assert.deepEqual(Object.keys(t.personas).sort(), Object.keys(snapshot[t.packId].posts).sort(), `${t.name}: post set matches live snapshot`);
  }
});

test("personas: structured, thick, slot-faithful per post", () => {
  let posts = 0;
  for (const t of teams) {
    for (const [agentId, persona] of Object.entries(t.personas)) {
      posts++;
      const prev = snapshot[t.packId].posts[agentId]?.persona ?? "";
      assert.ok(persona.length >= 380, `${t.name}/${agentId}: ${persona.length} chars (≥380)`);
      assert.ok(persona.includes("【职责边界】"), `${t.name}/${agentId}: 职责边界`);
      assert.ok(persona.includes("【输出契约】") || persona.includes("【工作纪律】"), `${t.name}/${agentId}: 契约/纪律小节`);
      assert.ok(persona.includes("report_status"), `${t.name}/${agentId}: report_status 契约`);
      assert.ok(["绝不编造", "不给结论", "不替其编造", "不臆造"].some((w) => persona.includes(w)), `${t.name}/${agentId}: 诚实纪律句`);
      // 字面转义陷阱：插入换行时若写成 "\\n\\n" 会以反斜杠+n 原样上架（2026-11-01 真机逮到）
      assert.ok(!persona.includes("\\n"), `${t.name}/${agentId}: 不得含字面 \\n 转义`);
      for (const slot of deriveSlots(prev)) {
        assert.ok(persona.includes(slot), `${t.name}/${agentId}: 槽位 ${slot} 逐字保留`);
      }
    }
  }
  assert.equal(posts, 35, "35 posts total");
});

test("skills: ≥2 per team, gate charset, executable length", () => {
  for (const t of teams) {
    assert.ok((t.skills ?? []).length >= 2, `${t.name}: skills ≥2`);
    const names = new Set();
    for (const s of t.skills) {
      assert.match(s.name, /^[A-Za-z0-9._-]{1,64}$/, `${t.name}/${s.name}: 发布门字符集`);
      assert.ok(!names.has(s.name), `${t.name}: 技能名不重复 (${s.name})`);
      names.add(s.name);
      assert.ok((s.description ?? "").length > 0, `${t.name}/${s.name}: description`);
      assert.ok((s.content ?? "").length >= 200, `${t.name}/${s.name}: content ≥200`);
      assert.ok(!(s.content ?? "").includes("\\n"), `${t.name}/${s.name}: 不得含字面 \\n 转义`);
    }
  }
});

test("mcpServers: only real registry names with real tool leaves", () => {
  for (const t of teams) {
    for (const x of t.mcpServers ?? []) {
      const known = registryAllow[x.registryName];
      assert.ok(Array.isArray(known), `${t.name}: ${x.registryName} 在册`);
      assert.ok((x.allowTools ?? []).length > 0, `${t.name}/${x.registryName}: allowTools 非空`);
      for (const tool of x.allowTools) {
        assert.ok(known.includes(tool), `${t.name}/${x.registryName}: 工具名在册 (${tool})`);
      }
    }
  }
});

test("overlay keeps structure/identity to the manifest", () => {
  for (const t of teams) {
    for (const k of Object.keys(t)) {
      assert.ok(["packId", "name", "personas", "skills", "mcpServers"].includes(k), `${t.name}: overlay key ${k}`);
    }
    assert.equal(t.name, snapshot[t.packId].name, `${t.name}: 包名与现场一致`);
  }
});
