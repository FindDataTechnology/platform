// ── facade 的策展注释轨（facade:<slug>）───────────────────────────────────────
//
// 2026-11-24 真机走查发现：英文界面下 56 支 facade 全显示中文。根因不是前端取错
// 槽 —— 是 facade 物种**根本没有注释轨**，`zhFallbackAnnotation` 把同一段中文
// 灌进五个语言槽（见 facet/supply-catalog.js）。MCP 与技能都有轨
// （market-annotations.json 的 entries / skills，25 + 278 条，五语齐全），
// facade 与 data-anchor 没有。
//
// 这里钉三件事：
//   1. 有轨时按 locale 取到的是真语言，不是 zh 的副本；
//   2. 轨在 market-annotations.json 的 `facades` 键（按 slug 索引）——
//      不放进 `entries`：那张表的键是 MCP registry 名，有 key-shape 闸守着；
//   3. 没有轨时退回兜底，「没配」与「配了」在输出上可区分。
//
//   node --test scripts/test-facade-annotations.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { projectFacadeEntries } from "../facet/supply-catalog.js";

const ENTRY = {
  canonical: { brief: "FindData's reception persona." },
  human: {
    zh: { name: "寻数分身", summary: "寻数的接待分身。" },
    en: { name: "FindData Twin", summary: "FindData's reception persona." },
    ja: { name: "尋数の分身", summary: "尋数の受付役。" },
    es: { name: "Gemelo de FindData", summary: "La recepción de FindData." },
    fr: { name: "Jumeau FindData", summary: "L'accueil de FindData." },
  },
  provenance: { source: "finddata-facet-annotations", updatedAt: "2026-11-24" },
};

const TRACK = { "packs-abc-reception": ENTRY };
const lookup = (key) => TRACK[key] ?? TRACK[String(key).toLowerCase()];

const row = (slug) => ({ slug, name: "寻数分身", description: "寻数的接待分身。", status: "serving" });

test("有轨时五个语言槽是真语言，不是 zh 的副本", () => {
  const { facades } = projectFacadeEntries([row("packs-abc-reception")], { annotationFn: lookup, asOf: "x" });
  const human = facades[0].annotation.human;

  assert.equal(human.zh.name, "寻数分身");
  assert.equal(human.en.name, "FindData Twin");
  for (const locale of ["en", "ja", "es", "fr"]) {
    assert.notEqual(human[locale].summary, human.zh.summary, `${locale} 槽不得等于 zh 槽`);
  }
  assert.equal(facades[0].annotation.provenance.source, "finddata-facet-annotations");
});

test("slug 大小写不同也命中同一条轨（与去重同一口径）", () => {
  // 两个来源的真实形态：万星 serving 面给小写、registry AgentCard 给原始大小写。
  const { facades } = projectFacadeEntries([row("packs-ABC-Reception")], { annotationFn: lookup, asOf: "x" });
  assert.equal(facades[0].annotation.human.en.name, "FindData Twin");
});

test("没有轨时退回兜底，且来源可区分", () => {
  const { facades } = projectFacadeEntries([row("some-other-agent")], { annotationFn: lookup, asOf: "x" });
  const human = facades[0].annotation.human;
  assert.equal(human.en.summary, human.zh.summary, "无轨时仍是 zh 兜底");
  assert.equal(facades[0].annotation.provenance.source, "wanxing-facade", "兜底来源必须写明");
});

test("没配查找器时行为与改造前逐字一致", () => {
  const withNone = projectFacadeEntries([row("packs-abc-reception")], { asOf: "x" }).facades[0].annotation;
  const withNull = projectFacadeEntries([row("packs-abc-reception")], { annotationFn: null, asOf: "x" }).facades[0].annotation;
  assert.deepEqual(withNone, withNull);
  assert.equal(withNone.human.en.name, withNone.human.zh.name, "未配轨 = 五个槽都是 zh");
});

test("上游自带 annotation 时不覆盖它", () => {
  const upstream = { ...ENTRY, human: { ...ENTRY.human, en: { name: "Upstream Name", summary: "Upstream." } } };
  const { facades } = projectFacadeEntries([{ ...row("packs-abc-reception"), annotation: upstream }], {
    annotationFn: lookup,
    asOf: "x",
  });
  assert.equal(facades[0].annotation.human.en.name, "Upstream Name", "上游给的注释优先于本仓策展轨");
});
