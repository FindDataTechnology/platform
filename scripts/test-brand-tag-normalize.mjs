#!/usr/bin/env node
// ── 品牌 tag 归一语法 (overhaul-market-catalog-presentation 5.3) ────────────
// Pins:
//   1. zh 品牌双写词 → 受控线 slug（柏讯→wire / 识律→lex / 萬星→wanxing）
//   2. 同包双写去重保序（wire 在柏讯之后不重复出现）
//   3. en.tags 槽位同步：品牌槽改成同一 slug、去重与 zh 同索引、长度恒等
//   4. 非品牌自由标签原样（归一只动双写对）
//   5. en.tags 缺席/长度不齐 → 直接以归一后 zh tags 兜底（slug 是跨语言常量）
//
//   node --test scripts/test-brand-tag-normalize.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { normalizeTags, normalizeEnTags } = await import("./normalize-brand-tags.mjs");

test("品牌双写词映射到线 slug，自由标签原样", () => {
  assert.deepEqual(normalizeTags(["柏讯", "量化", "策略"]).tags, ["wire", "量化", "策略"]);
  assert.deepEqual(normalizeTags(["识律", "政心"]).tags, ["lex", "政心"]);
  assert.deepEqual(normalizeTags(["团队", "共用层"]).tags, ["团队", "共用层"]);
  assert.equal(normalizeTags(["团队"]).changed, false);
  assert.equal(normalizeTags(["柏讯"]).changed, true);
});

test("同包双写去重保序（柏讯+wire→wire 单写）", () => {
  const r = normalizeTags(["柏讯", "量化", "wire"]);
  assert.deepEqual(r.tags, ["wire", "量化"]);
  assert.equal(r.changed, true);
  const r2 = normalizeTags(["wire", "柏讯"]);
  assert.deepEqual(r2.tags, ["wire"]);
});

test("en.tags 品牌槽同步成 slug、与归一 zh 等长对齐", () => {
  const r = normalizeEnTags(["柏讯", "量化"], ["Baixun", "Quant"]);
  assert.deepEqual(r.tags, ["wire", "Quant"]);
  assert.equal(r.changed, true);
});

test("en.tags 双写去重与 zh 同索引（柏讯+wire 双写包）", () => {
  const r = normalizeEnTags(["柏讯", "量化", "wire"], ["Baixun", "Quant", "wire"]);
  assert.deepEqual(r.tags, ["wire", "Quant"]);
  assert.equal(r.tags.length, normalizeTags(["柏讯", "量化", "wire"]).tags.length);
});

test("en.tags 缺席或不齐 → 以归一后 zh tags 兜底（slug 跨语言常量）", () => {
  assert.deepEqual(normalizeEnTags(["柏讯", "量化"], undefined).tags, ["wire", "量化"]);
  assert.deepEqual(normalizeEnTags(["柏讯", "量化"], ["Baixun"]).tags, ["wire", "量化"]);
  assert.deepEqual(normalizeEnTags(["团队"], ["Team"]).tags, ["Team"]);
});

test("萬星/万星 双拼都归一", () => {
  assert.deepEqual(normalizeTags(["萬星", "文档"]).tags, ["wanxing", "文档"]);
  assert.deepEqual(normalizeTags(["万星", "文档"]).tags, ["wanxing", "文档"]);
});
