#!/usr/bin/env node
// ── 市场读面的语言轨道 tests (overhaul-market-catalog-presentation P0) ──────
//
// Pins the server faces of "switching language actually switches the content":
//   1. the line-label projection: zh canonical word stays the filter identity,
//      `lineLabel` follows the request locale, unmapped words pass through,
//      unknown locales fall back to zh
//   2. cross-track search: a non-zh request matches the overlay block's
//      name/description (a keyword the zh columns never contain), while a zh
//      request keeps the pre-change single-track semantics
//   3. list rows carry BOTH `line` (canonical) and `lineLabel` (projected) on
//      every path — zh rows too
//
// The client-side silent refetch is pinned by e2e (facet-shell.spec.js) — a
// node unit test cannot observe a browser refetch.
//
//   node --test scripts/test-market-locale-refetch.mjs

import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { lineLabelOf, lineSlugOf } = await import("../lib/pack-taxonomy.js");
const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");

// ── 1. line-label projection ─────────────────────────────────────────────────

const zhWord = "柏讯 · 数据与情报";

test("lineLabelOf: zh 请求回落主轨线词（它是分面筛选身份，永不翻译）", () => {
  assert.equal(lineLabelOf(zhWord, "zh"), zhWord);
  assert.equal(lineLabelOf(zhWord, "zh-CN"), zhWord);
  assert.equal(lineLabelOf(zhWord, undefined), zhWord);
});

test("lineLabelOf: 五种界面语言各得本语标签，品牌标记沿用 LineLadder 概念名", () => {
  assert.equal(lineLabelOf(zhWord, "en"), "Wire · Data & Intelligence");
  assert.equal(lineLabelOf(zhWord, "es"), "Wire · Datos e inteligencia");
  assert.equal(lineLabelOf(zhWord, "fr"), "Wire · Données et renseignement");
  assert.equal(lineLabelOf(zhWord, "ja"), "Wire · データとインテリジェンス");
  assert.equal(lineLabelOf("壹座 · 智能体团队", "en"), "Base · Agent Teams");
  assert.equal(lineLabelOf("识律 · 法律智能", "en"), "Lex · Legal Intelligence");
  assert.equal(lineLabelOf("谦面 · 业务流", "en"), "Facet · Business Flows");
  assert.equal(lineLabelOf("萬星 · 智能体连接", "en"), "Constellation · Agent Connectivity");
});

test("lineLabelOf: 未映射线词原样透传，未覆盖 locale 回落 zh", () => {
  // env 自定义线 / 透传 slug：present-as-is 不变（不猜测、不消失）
  assert.equal(lineLabelOf("custom-line", "en"), "custom-line");
  assert.equal(lineLabelOf("custom-line", "zh"), "custom-line");
  // 词表未声明该语言的标签 → 回落 zh 主轨
  assert.equal(lineLabelOf(zhWord, "de"), zhWord);
});

test("lineSlugOf: 五线 slug 映射，未映射返回 null", () => {
  assert.equal(lineSlugOf(zhWord), "wire");
  assert.equal(lineSlugOf("壹座 · 智能体团队"), "base");
  assert.equal(lineSlugOf("custom-line"), null);
  assert.equal(lineSlugOf(""), null);
});

// ── 2/3. registry read face ──────────────────────────────────────────────────

function bilingualManifest(overrides = {}) {
  return {
    name: "柏讯 · 策略工坊",
    description: "策略设计、回测解读、风控参数与模拟盘督导四件套。",
    tags: ["柏讯", "wire"],
    category: "wire",
    skills: [
      {
        name: "strategy-design",
        description: "权重语义与 universe 验证",
        content: "# 策略设计\n只做思考面。",
      },
    ],
    mcpServers: [],
    agents: [],
    i18n: {
      en: {
        name: "Wire · Strategy Lab",
        description: "Strategy design, backtest reading, risk parameters and paper-run supervision.",
        tags: ["Baixun", "wire"],
      },
    },
    ...overrides,
  };
}

function zhOnlyManifest(overrides = {}) {
  return bilingualManifest({
    name: "识律 · 合同审查",
    description: "五阶段合同审查工作流。",
    category: "legal",
    i18n: undefined,
    ...overrides,
  });
}

async function seededRegistry() {
  const dir = mkdtempSync(path.join(tmpdir(), "market-locale-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  const author = "author@example.com";
  reg.publish({ email: author, manifest: bilingualManifest() });
  reg.publish({ email: author, manifest: zhOnlyManifest() });
  return { reg, dir };
}

test("list 行同时携带规范线词与投影标签；zh 请求两者相同", async () => {
  const { reg, dir } = await seededRegistry();
  try {
    const zh = reg.list({ locale: "zh" }).packs.find((p) => p.category === "wire");
    assert.equal(zh.line, "柏讯 · 数据与情报");
    assert.equal(zh.lineLabel, "柏讯 · 数据与情报");

    const en = reg.list({ locale: "en" }).packs.find((p) => p.category === "wire");
    // 规范线词不动（筛选身份），标签随请求
    assert.equal(en.line, "柏讯 · 数据与情报");
    assert.equal(en.lineLabel, "Wire · Data & Intelligence");
    // 显示字段随 overlay 呈现英文
    assert.equal(en.name, "Wire · Strategy Lab");

    // 未覆盖 locale 回落 zh 标签
    const de = reg.list({ locale: "de" }).packs.find((p) => p.category === "wire");
    assert.equal(de.lineLabel, "柏讯 · 数据与情报");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("跨轨道搜索：en 关键词命中只有 overlay 才有的英文名；zh 语义不变", async () => {
  const { reg, dir } = await seededRegistry();
  try {
    // zh 列里没有 "Strategy"——只有 i18n.en 才有
    const en = reg.list({ locale: "en", search: "Strategy Lab" });
    assert.equal(en.total, 1);
    assert.equal(en.packs[0].name, "Wire · Strategy Lab");

    // overlay 描述也可命中
    const enDesc = reg.list({ locale: "en", search: "backtest reading" });
    assert.equal(enDesc.total, 1);

    // zh 请求保持变更前单轨语义：en 关键词不命中
    const zhMiss = reg.list({ locale: "zh", search: "Strategy Lab" });
    assert.equal(zhMiss.total, 0);

    // zh 关键词照常命中（zh 主轨）
    const zhHit = reg.list({ locale: "zh", search: "策略工坊" });
    assert.equal(zhHit.total, 1);

    // 无匹配关键词返回空而不是全量
    const none = reg.list({ locale: "en", search: "no-such-keyword-xyz" });
    assert.equal(none.total, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("跨轨道搜索命中带语言后缀的 locale 请求（en-US 找到 en 块）", async () => {
  const { reg, dir } = await seededRegistry();
  try {
    const enUS = reg.list({ locale: "en-US", search: "Strategy Lab" });
    assert.equal(enUS.total, 1);
    assert.equal(enUS.packs[0].lineLabel, "Wire · Data & Intelligence");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("纯 zh 包在 en 搜索下按 zh 主轨命中（回落语义不丢内容）", async () => {
  const { reg, dir } = await seededRegistry();
  try {
    const en = reg.list({ locale: "en", search: "合同审查" });
    assert.equal(en.total, 1);
    assert.equal(en.packs[0].category, "legal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 5.3 验证条款的生产缺陷回归：en 下列表/详情顶层 tags 列随 locale ─────────
// （上线当日实测：投影层 tags 覆盖已在，但 list summary 与 detail 顶层列都
// 只拷 name/description，zh 存储 tags 原样穿透到 en 轨。）
test("en 请求：列表顶层 tags 列随 en.tags 投影；zh 请求原样", async () => {
  const { reg, dir } = await seededRegistry();
  try {
    const app = express();
    registerPackRoutes(app, {
      registry: reg,
      resolveUser: () => null,
      rejectUnauthenticated: () => {},
      creatorGroups: ["creators"],
      anonymousRead: true,
      officialAuthors: [],
    });
    const server = http.createServer(app);
    server.listen(0);
    const get = async (p) => (await fetch(`http://127.0.0.1:${server.address().port}${p}`)).json();
    const enRow = (await get("/api/packs?locale=en")).packs.find((x) => x.name === "Wire · Strategy Lab");
    assert.deepEqual(enRow.tags, ["Baixun", "wire"], "en 列表 tags 必须随副轨");
    const zhRow = (await get("/api/packs")).packs.find((x) => x.name === "柏讯 · 策略工坊");
    assert.deepEqual(zhRow.tags, ["柏讯", "wire"], "zh 列表 tags 原样");
    const enDetail = await get(`/api/packs/${enRow.id}?locale=en`);
    assert.deepEqual(enDetail.tags, ["Baixun", "wire"], "en 详情顶层 tags 列同律");
    server.close();
  } finally {
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
