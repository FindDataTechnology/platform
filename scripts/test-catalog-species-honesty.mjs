// ── 目录页的物种集合与卡片信息量（overhaul-pack-detail-presentation 8.1 / 8.2）
//
// 页面上曾有两处自相矛盾：文案说「六个物种」，页签只铺五条（`plugin` 在枚举里
// 但没有端点）；「全部」页签的每张卡只写一句「Open this species」——一个按钮说
// 「点我」，对「背后是什么」零信息，而那句话本来就有（`catalog.speciesDesc.*`）。
//
//   node --test scripts/test-catalog-species-honesty.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SPECIES_SPECS } from "../facet/web/src/catalog-model.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VIEW = readFileSync(join(ROOT, "facet", "web", "src", "CatalogView.tsx"), "utf8");
const LOCALE = (loc) =>
  JSON.parse(readFileSync(join(ROOT, "web", "src", "locales", loc, "common.json"), "utf8"));
const LOCALES = ["en", "zh-CN", "es", "fr", "ja"];

test("页签数来自 SPECIES_SPECS，文案按它插值（不写死数字）", () => {
  assert.equal(SPECIES_SPECS.length, 5, "facet 当前铺五个物种");
  // 文案必须带插值占位，否则改了枚举数字又会漂
  for (const loc of LOCALES) {
    const lead = LOCALE(loc).catalog?.lead ?? "";
    assert.match(lead, /\{\{n\}\}/, `${loc}: catalog.lead 必须用 {{n}} 插值，而不是写死数字`);
    assert.doesNotMatch(lead, /\b六\b|\bSix\b|\bSeis\b|\bSix\b|\b6\b/, `${loc}: catalog.lead 不得写死物种数`);
  }
  assert.match(VIEW, /catalog\.lead", \{ n: SPECIES_SPECS\.length \}/, "渲染时必须传入实际的物种数");
});

test("「全部」页签的每张卡承载该物种的一句话说明", () => {
  assert.match(VIEW, /catalog\.speciesDesc\.\$\{s\.species\}/, "物种卡必须渲染 speciesDesc");
  assert.doesNotMatch(VIEW, /catalog\.allHint/, "不得再用「Open this species」充数");
});

test("每个被铺出的物种都有非空的 speciesDesc（否则卡片是空的）", () => {
  for (const loc of LOCALES) {
    const d = LOCALE(loc);
    for (const s of SPECIES_SPECS) {
      const desc = d.catalog?.speciesDesc?.[s.species] ?? "";
      assert.ok(desc.trim().length > 0, `${loc}: catalog.speciesDesc.${s.species} 为空——卡片会是一片空白`);
    }
  }
});
