#!/usr/bin/env node
// ── Draft assembly rules (overhaul-market-catalog-presentation 4.7/4.8) ──────
// Pure rules shared by the editor save path; pinned WITHOUT a DOM:
//   1. 不写翻译不产生空 i18n 键 — nothing authored → null (the caller omits the
//      key); scalars serialize only trimmed-non-empty;
//   2. all-or-nothing groups — tags serialize only when EVERY slot is filled
//      (the validator's equal-length rule), guide only when every declared
//      step has title AND body;
//   3. entity maps keyed per declared entity, descriptions under `description`,
//      names under `name` (the i18n overlay shapes);
//   4. 保存零静默改写 — outOfVocabulary only NAMES offenders; the caller
//      (publish) decides, the save path preserves everything.
//
//   node --test scripts/test-pack-draft-lift.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { assembleEnOverlay, outOfVocabulary } = await import("../web/src/lib/packDraftLift.ts");

test("全空 → null（调用方不落 i18n 键；空串绝不入块）", () => {
  assert.equal(assembleEnOverlay({ name: "  ", description: "", tags: ["", ""] }), null);
  assert.equal(assembleEnOverlay({}), null);
});

test("标量逐字段独立；键名 i18n overlay 形状", () => {
  const block = assembleEnOverlay({ name: " Legal Bot ", promise: "One screen." });
  assert.deepEqual(block, { name: "Legal Bot", promise: "One screen." });
});

test("tags 整组：有一格空即整组不写；填满按序写出", () => {
  assert.equal(assembleEnOverlay({ tags: ["Law", ""] })?.tags, undefined);
  assert.deepEqual(assembleEnOverlay({ tags: ["Law", "Contract"] }).tags, ["Law", "Contract"]);
});

test("guide 整组：每步 title+body 全齐才写；部分即整组省略", () => {
  const partial = { guideSteps: [{ title: "One", body: "a" }, { title: "Two", body: "" }, { title: "Three", body: "c" }] };
  assert.equal(assembleEnOverlay(partial)?.guide, undefined);
  const full = assembleEnOverlay({ guideSteps: [{ title: "One", body: "a" }, { title: "Two", body: "b" }, { title: "Three", body: "c" }] });
  assert.deepEqual(full.guide, { steps: [{ title: "One", body: "a" }, { title: "Two", body: "b" }, { title: "Three", body: "c" }] });
});

test("实体映射按声明键分形：skills/mcpServers 走 description，agents/bots 走 name", () => {
  const block = assembleEnOverlay({
    skills: { "skill-a": "A desc", "skill-b": "  " },
    mcpServers: { "law-bench": "Bench" },
    agents: { "pack-a-reviewer": "Reviewer" },
    bots: { bot1: "Bot One" },
  });
  assert.deepEqual(block.skills, { "skill-a": { description: "A desc" } });
  assert.deepEqual(block.mcpServers, { "law-bench": { description: "Bench" } });
  assert.deepEqual(block.agents, { "pack-a-reviewer": { name: "Reviewer" } });
  assert.deepEqual(block.bots, { bot1: { name: "Bot One" } });
});

test("词表校验只提名越界值（发布面用）；合法多选放行、空串/非串也算越界", () => {
  assert.deepEqual(outOfVocabulary(["legal", "investing"], ["legal", "investing", "risk"]), []);
  assert.deepEqual(outOfVocabulary(["legal", "柏讯", "  "], ["legal", "investing"]), ["柏讯", "  "]);
  assert.deepEqual(outOfVocabulary("not-array", ["legal"]), []);
});
