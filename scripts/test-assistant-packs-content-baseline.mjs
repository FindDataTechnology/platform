#!/usr/bin/env node
// ── Official assistant/capability-pack content baseline (modernize-official-assistant-packs) ──
//
// 静态守卫第三批（12 支助手型/套件型官方包）staging 稿，与发布脚本断言同源、不联网：
//   1. 覆盖：12 支全在，岗位集合与 source-snapshot.json 一致
//   2. persona：≥380 字、【职责边界】+【输出契约】、诚实纪律句、无字面 \n；
//      改版前声明的 report_status 语境槽位逐字保留（自动派生——只有舰队岗才有）
//   3. 共享岗：pack-wire-macro-analyst / pack-wire-valuation-analyst 跨包逐字节一致
//   4. 转正包：nano-pdf overlay 绝不带 skills（技能正文=上游钉定快照，一字不动）
//   5. 新技能：ASCII 名（发布门字符集）、≥200 字、无字面 \n
//   6. overlay 只碰 personas/skills 两个内容桶（第三批零 mcp 改动）
//
//   node --test scripts/test-assistant-packs-content-baseline.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const staging = path.join(root, "openspec/changes/archive/2026-11-02-modernize-official-assistant-packs/staging");

const snapshot = JSON.parse(fs.readFileSync(path.join(staging, "source-snapshot.json"), "utf8"));
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

test("coverage: 12 assistant packs, post sets match snapshot", () => {
  assert.equal(teams.length, 12, "twelve packs");
  assert.deepEqual(teams.map((t) => t.packId).sort(), Object.keys(snapshot).sort(), "packIds match snapshot");
  for (const t of teams) {
    const touched = Object.keys(t.personas);
    for (const aid of touched) {
      assert.ok(snapshot[t.packId].posts[aid] !== undefined, `${t.name}/${aid}: 岗位在快照内`);
    }
    assert.equal(t.name, snapshot[t.packId].name, `${t.name}: 包名与现场一致`);
  }
});

test("personas: structured, honest, no literal escapes, prior slots kept", () => {
  let n = 0;
  for (const t of teams) {
    for (const [agentId, persona] of Object.entries(t.personas)) {
      n++;
      const prev = snapshot[t.packId].posts[agentId];
      assert.ok(persona.startsWith(prev), `${t.name}/${agentId}: 改版前文本逐字保留（前缀一致）`);
      assert.ok(persona.length >= 380, `${t.name}/${agentId}: ${persona.length} 字（≥380）`);
      assert.ok(persona.includes("【职责边界】") && persona.includes("【输出契约】"), `${t.name}/${agentId}: 结构段`);
      assert.ok(["绝不编造", "不给结论", "不替其编造", "不臆造"].some((w) => persona.includes(w)), `${t.name}/${agentId}: 诚实句`);
      assert.ok(!persona.includes("\\n"), `${t.name}/${agentId}: 无字面 \\n`);
      for (const slot of deriveSlots(prev)) {
        assert.ok(persona.includes(slot), `${t.name}/${agentId}: 槽位 ${slot} 逐字保留`);
      }
    }
  }
  assert.equal(n, 13, "13 personas deepened");
});

test("shared posts are byte-identical across packs", () => {
  const byAgent = new Map();
  for (const t of teams) {
    for (const [aid, persona] of Object.entries(t.personas)) {
      if (!byAgent.has(aid)) byAgent.set(aid, new Set());
      byAgent.get(aid).add(persona);
    }
  }
  for (const [aid, variants] of byAgent) {
    assert.equal(variants.size, 1, `${aid}: 跨包同岗同文（${variants.size} 种变体）`);
  }
});

test("adopted pack keeps upstream skill untouched (no skills in overlay)", () => {
  for (const t of teams) {
    if (snapshot[t.packId].adopted) {
      assert.equal(t.skills, undefined, `${t.name}: 转正包 overlay 不带 skills`);
    }
  }
});

test("new skills: gate charset, executable length, no literal escapes", () => {
  let count = 0;
  for (const t of teams) {
    for (const s of t.skills ?? []) {
      count++;
      assert.match(s.name, /^[A-Za-z0-9._-]{1,64}$/, `${t.name}/${s.name}: 发布门字符集`);
      assert.ok(!snapshot[t.packId].skillNames.includes(s.name), `${t.name}/${s.name}: 新技能不与既有重名`);
      assert.ok((s.description ?? "").length > 0, `${t.name}/${s.name}: description`);
      assert.ok((s.content ?? "").length >= 200, `${t.name}/${s.name}: content ≥200`);
      assert.ok(!(s.content ?? "").includes("\\n"), `${t.name}/${s.name}: 无字面 \\n`);
    }
  }
  assert.equal(count, 4, "4 new skills (architect ×2 + product-intro ×2)");
});

test("overlay touches only personas/skills (no mcp in batch 3)", () => {
  for (const t of teams) {
    for (const k of Object.keys(t)) {
      assert.ok(["packId", "name", "personas", "skills"].includes(k), `${t.name}: overlay key ${k}`);
    }
  }
});
