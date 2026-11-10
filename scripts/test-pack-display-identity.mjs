#!/usr/bin/env node
// ── 卡片身份/承诺推导 tests (overhaul-market-catalog-presentation P2) ─────────
//
// Pins the derivations the card cannot drift on:
//   1. the client seal table keys EXACTLY the server's declared line words
//      (a renamed sixth line is caught here, never silently rendered as a
//      name-initial)
//   2. the promise degradation chain against the REAL function (Node type
//      stripping imports the .ts source — no string surgery): CJK terminators,
//      "v1.2" never cut mid-number, width cap with boundary + ellipsis
//   3. the card's anchor discipline: [data-testid^="pack-card-"] is the e2e
//      card counter — a child anchor starting with that prefix inflates the
//      count (the exact regression facet-shell caught on 2026-11-03)
//
//   node --test scripts/test-pack-display-identity.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const { lineSlugs, lineWordOf } = await import("../lib/pack-taxonomy.js");
const { markCharOf, firstSentence, displayWidth } = await import("../web/src/lib/packIdentity.ts");

// ── 1. seal table ↔ server line words ───────────────────────────────────────

test("印章字表与服务端线表逐字配对（第五条线改了名字必须在这里红）", () => {
  const src = fs.readFileSync(path.join(root, "web/src/lib/packIdentity.ts"), "utf8");
  const table = src.slice(src.indexOf("const LINE_MARK_CHARS"), src.indexOf("/** The single character"));
  const entries = [...table.matchAll(/"([^"]+)":\s*"([^"]{1,2})"/g)].map((m) => [m[1], m[2]]);
  const serverWords = lineSlugs().map((s) => lineWordOf(s));
  assert.equal(entries.length, serverWords.length, `印字表 ${entries.length} 条 vs 服务端 ${serverWords.length} 条`);
  for (const [word, ch] of entries) {
    assert.ok(serverWords.includes(word), `印字表有 '${word}' 但服务端没有这条线`);
    assert.equal(Array.from(ch).length, 1, `${word} 的印字必须单字`);
  }
  for (const word of serverWords) {
    assert.ok(entries.some(([w]) => w === word), `服务端线 '${word}' 缺印字（会静默退成名字首字）`);
  }
});

test("markCharOf: 已归位线取印字，未归位/分身回落名字首字", () => {
  assert.equal(markCharOf("柏讯 · 数据与情报", "柏讯 · 策略工坊"), "柏");
  assert.equal(markCharOf("壹座 · 智能体团队", "内容工厂"), "壹");
  // 未归位（facade/company → null 线、透传 slug）：取显示名首字——诚实，不猜线
  assert.equal(markCharOf("", "寻数分身"), "寻");
  assert.equal(markCharOf("some-unmapped-slug", "Wire · Strategy Lab"), "W");
  assert.equal(markCharOf(undefined, undefined), "?");
});

// ── 2. promise degradation chain ─────────────────────────────────────────────

test("firstSentence: 中文句末标点后即止；英文句点须跟空白（v1.2 不切断）", () => {
  assert.equal(firstSentence("柏讯策略工坊四件套：策略设计。第二句。"), "柏讯策略工坊四件套：策略设计。");
  assert.equal(firstSentence("Wire Strategy Lab v1.2 ships soon. Second."), "Wire Strategy Lab v1.2 ships soon.");
  assert.equal(firstSentence("整段无终止符的中文长文"), "整段无终止符的中文长文");
  assert.equal(firstSentence("  前后空白修剪。尾巴。"), "前后空白修剪。");
  assert.equal(firstSentence(undefined), "");
});

test("承诺超预算按边界截断补省略号，绝不半词半句", () => {
  const long =
    "这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的中文句子，后面还有更多内容，永远讲不完，直到超出卡片预算为止。";
  const got = firstSentence(long);
  assert.ok(got.endsWith("…"), `超预算必须省略号收尾，实际: ${got}`);
  assert.ok(displayWidth(got) <= 61, `预算 60 实际 ${displayWidth(got)}`);

  const longLatin =
    "The quick brown fox jumps over the lazy dog and then keeps running far beyond the budgeted width of a market card promise line forever and ever.";
  const gotLatin = firstSentence(longLatin);
  assert.ok(gotLatin.endsWith("…"));
  // 真边界判据：省略号前的文本是原文的严格前缀，且原文在截断点处是空白
  //（截在词中间意味着下一字符仍是字母）
  const prefixLen = gotLatin.length - 1;
  assert.ok(longLatin.startsWith(gotLatin.slice(0, -1)));
  const next = longLatin[prefixLen];
  assert.ok(next === undefined || /\s/.test(next), `截断点落在半词中: …${gotLatin.slice(-12)}`);

  // 短文本逐字节不变
  assert.equal(firstSentence("短承诺。"), "短承诺。");
});

// ── 3. anchor prefix discipline ─────────────────────────────────────────────

test("卡片子元素锚不得以 pack-card- 开头（e2e 前缀计数纪律）", () => {
  const cardSrc = fs.readFileSync(path.join(root, "web/src/components/packs/PackCard.tsx"), "utf8");
  const anchors = [...cardSrc.matchAll(/data-testid=\{`([^`]+)`\}/g)].map((m) => m[1]);
  // 允许：卡片本体锚（宿主传入）、三枚徽章锚（历史 e2e 锚点，不以 pack-card- 开头）
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 断言对象就是模板占位符的源文本（检查 data-testid 模板锚的形状），不是插值
  const ownBad = anchors.filter((a) => !a.includes("${testId}") && a.startsWith("pack-card-"));
  assert.deepEqual(ownBad, [], `pack-card- 前缀被子锚占用: ${ownBad}`);
  // ${testId} 插值锚是卡片自身/信号——信号锚必须用 pack-signals- 前缀
  const signalAnchors = anchors.filter((a) => a.includes("pack-") && a.includes("signals"));
  assert.equal(signalAnchors.length, 3, "技能/角色/工具三枚信号锚");
  for (const a of signalAnchors) assert.ok(a.startsWith("pack-signals-"), `信号锚前缀违规: ${a}`);
});

test("五语 packs.specSheet.compactRoles 与 PackCard 信号消费一致", () => {
  const cardSrc = fs.readFileSync(path.join(root, "web/src/components/packs/PackCard.tsx"), "utf8");
  assert.match(cardSrc, /packs\.specSheet\.compactSkills/);
  assert.match(cardSrc, /packs\.specSheet\.compactRoles/);
  assert.match(cardSrc, /packs\.specSheet\.compactTools/);
  for (const locale of ["zh-CN", "en", "es", "fr", "ja"]) {
    const j = JSON.parse(fs.readFileSync(path.join(root, `web/src/locales/${locale}/common.json`), "utf8"));
    assert.ok(j.packs?.specSheet?.compactRoles?.includes("{{n}}"), `${locale}: compactRoles 缺 {{n}}`);
  }
});
