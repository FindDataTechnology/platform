#!/usr/bin/env node
// ── 草稿→叠加块合并语法 (overhaul-market-catalog-presentation 5.2 工具面) ──
//
// mergeOverlay is the ONE place a filled review draft becomes manifest bytes.
// Pins:
//   1. purely additive: zh main track and untouched overlay keys survive
//      byte-identically; blanks in the draft write nothing
//   2. every coverage path grammar form round-trips (scalar/tags/guide/named/
//      item) so localeCoverage reaches ZERO exactly as the apply gate asserts
//   3. half-filled drafts merge only their filled slots (the apply script's
//      pre-flight refuses unfilled drafts separately, but the merge itself
//      must not invent empty strings)
//
//   node --test scripts/test-official-en-merge.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { mergeOverlay } = await import("./apply-official-en-coverage.mjs");
const { localeCoverage } = await import("../lib/pack-locale-coverage.js");

const ZH = {
  name: "合同审查套件",
  description: "三棒流水：提取、比对、成稿。",
  tags: ["法务", "合同"],
  notes: "仅限已签署委托的案件使用。",
  guide: {
    steps: [
      { title: "上传合同", body: "支持 PDF/DOCX。" },
      { title: "风险比对", body: "逐条对照标准条款库。" },
    ],
  },
  skills: [
    { name: "clause-extractor", description: "提取合同条款", content: "# x" },
    { name: "risk-matcher", description: "对照条款库标注风险", content: "# y" },
  ],
  agents: [{ id: "reviewer", name: "审查岗", persona: "p" }],
  i18n: {
    en: {
      name: "Contract Review Suite",
      tags: ["Legal", "Contract"],
      skills: { "clause-extractor": { description: "Extract clauses" } },
    },
  },
};

const draft = [
  { path: "description", zh: ZH.description, en: "Three-stage flow: extract, match, draft." },
  { path: "notes", zh: ZH.notes, en: "Use only for cases with a signed engagement." },
  { path: "guide.steps[0].title", zh: "上传合同", en: "Upload the contract" },
  { path: "guide.steps[0].body", zh: "支持 PDF/DOCX。", en: "PDF/DOCX supported." },
  { path: "guide.steps[1].title", zh: "风险比对", en: "Risk match" },
  { path: "guide.steps[1].body", zh: "逐条对照标准条款库。", en: "Clause-by-clause against the standard library." },
  { path: "skills['risk-matcher'].description", zh: "对照条款库标注风险", en: "Flag risks against the clause library" },
  { path: "agents['reviewer'].name", zh: "审查岗", en: "Reviewer" },
];

test("合并后覆盖清零且 zh 主轨/既有叠加逐字节不动（纯增量）", () => {
  const next = mergeOverlay(ZH, draft);
  assert.equal(localeCoverage(next, "en").missing.length, 0, "覆盖必须清零");
  // zh 主轨原样
  assert.equal(next.name, ZH.name);
  assert.equal(next.description, ZH.description);
  assert.equal(next.guide.steps[0].title, "上传合同");
  assert.equal(next.skills[1].content, "# y");
  // 未被草稿提及的既有叠加条目原样保留
  assert.equal(next.i18n.en.name, "Contract Review Suite");
  assert.deepEqual(next.i18n.en.tags, ["Legal", "Contract"]);
  assert.equal(next.i18n.en.skills["clause-extractor"].description, "Extract clauses");
});

test("guide 按索引合并：steps 长度/顺序保持，兄弟键不清空", () => {
  const next = mergeOverlay(ZH, draft);
  assert.equal(next.i18n.en.guide.steps.length, 2);
  assert.equal(next.i18n.en.guide.steps[0].title, "Upload the contract");
  assert.equal(next.i18n.en.guide.steps[1].body, "Clause-by-clause against the standard library.");
});

test("空 en 槽什么都不写（不发半成品进叠加块）", () => {
  const partial = [
    { path: "description", zh: ZH.description, en: "" },
    { path: "agents['reviewer'].name", zh: "审查岗", en: null },
  ];
  const next = mergeOverlay(ZH, partial);
  assert.ok(!("description" in next.i18n.en), "空串不写入");
  assert.ok(!("agents" in next.i18n.en), "null 不写入");
  assert.ok(next.i18n.en.skills, "既有块不受牵连");
});

test("半草稿只清一半：覆盖计数随之递减但绝不为负（闸前校验的可信基础）", () => {
  const half = draft.slice(0, 4);
  const next = mergeOverlay(ZH, half);
  const cov = localeCoverage(next, "en");
  assert.ok(cov.missing.length > 0);
  assert.ok(cov.missing.includes("agents['reviewer'].name"));
  assert.ok(cov.covered < cov.total);
});

test("tags 草稿整数组写入，与 zh 同长度（对齐律的另一半）", () => {
  const next = mergeOverlay({ ...ZH, i18n: {} }, [{ path: "tags", zh: ZH.tags, en: ["Legal", "Contract"] }]);
  assert.deepEqual(next.i18n.en.tags, ["Legal", "Contract"]);
  assert.equal(localeCoverage(next, "en").missing.includes("tags"), false);
});
