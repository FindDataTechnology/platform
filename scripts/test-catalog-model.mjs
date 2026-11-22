// ── 目录页的物种适配（unify-material-catalog-page 1.x）───────────────────────
//
//   node --test scripts/test-catalog-model.mjs
//
// 六物种各有各的端点形状，目录页把它们归一成一个卡片模型。这里钉住三件事：
//
//   1. 每种形状都能映射出卡片（否则目录页会静默少一类）；
//   2. 源里没有的字段就是 null / 空，**绝不补默认值**——「源没给」和「源给了空」
//      必须可区分，这是上一轮踩过的坑（兜底函数编了个值，把缺失藏了起来）；
//   3. 形状不符时报告原因，不是静默返回空数组。
import { test } from "node:test";
import assert from "node:assert/strict";

import { SPECIES_SPECS, toCatalogItem, mapResponse, splitAnchors, defaultView } from "../facet/web/src/catalog-model.ts";

const specs = SPECIES_SPECS;

test("every species in the enumeration has a spec", () => {
  const declared = new Set(specs.map((s) => s.species));
  for (const s of ["pack", "skill", "mcp", "facade", "data-anchor"]) {
    assert.ok(declared.has(s), `missing spec for ${s}`);
  }
});

test("only mcp and skill declare a depth view", () => {
  const withDepth = specs.filter((s) => s.hasDepth).map((s) => s.species).sort();
  assert.deepEqual(withDepth, ["mcp", "skill"]);
});

test("pack maps name/description/category", () => {
  const item = toCatalogItem("pack", { name: "crm-suite", description: "客服套件", category: "fleet" });
  assert.equal(item.key, "pack:crm-suite");
  assert.equal(item.title, "crm-suite");
  assert.equal(item.summary, "客服套件");
  assert.deepEqual(item.badges, ["fleet"]);
  // 目录页就地打开详情，不再链到 #/packs（catalog-owns-browse-market-owns-trade D2）
  assert.equal(item.detail, true);
  assert.equal(item.href, null, "pack must not link out; the detail opens in place");
});

test("mcp prefers the annotation's name and summary", () => {
  const item = toCatalogItem("mcp", {
    name: "fd-open-data-mcp",
    displayName: "FindData Open Data",
    description: "raw description",
    annotation: { name: "寻数开放数据", summary: "注释摘要" },
  });
  assert.equal(item.title, "寻数开放数据");
  assert.equal(item.summary, "注释摘要");
  assert.equal(item.depth, true, "mcp has a depth view");
});

test("skill falls back to displayName when unannotated", () => {
  const item = toCatalogItem("skill", { name: "3-statement-model", displayName: "3-Statement Model", description: "d" });
  assert.equal(item.title, "3-Statement Model");
  assert.equal(item.depth, true);
});

test("facade states an undeployed agent as such instead of inventing a status", () => {
  // 契约变更（facet-catalog-species-curation 3.2）：未运行不再是徽标里的中文硬编码
  // ——它单独成 notRunning 标记，由 UI 用当前语言呈现；五语下不会再冒出中文。
  const undeployed = toCatalogItem("facade", { id: "x", name: "X", deployment: { state: "undeployed" } });
  assert.equal(undeployed.notRunning, true);
  assert.ok(!undeployed.badges.includes("未部署"), "no hardcoded Chinese in the badges");

  const serving = toCatalogItem("facade", { id: "y", name: "Y", runnable: "reachable", deployment: { state: "serving" } });
  assert.ok(serving.badges.includes("serving"));
  assert.notEqual(serving.notRunning, true, "a serving agent is not marked as not running");
});

test("facade with no deployment record does not claim a state", () => {
  const item = toCatalogItem("facade", { id: "z", name: "Z" });
  // 缺记录读作「未运行」——不是「正在服务」。标记走结构化字段，不走中文徽标。
  assert.equal(item.notRunning, true, "absence of a record reads as not running, never as serving");
});

test("data-anchor carries its kind as a badge", () => {
  const item = toCatalogItem("data-anchor", { id: "ind-1", name: "CPI", kind: "indicator" });
  assert.equal(item.key, "anchor:ind-1");
  assert.deepEqual(item.badges, ["indicator"]);
});

test("an entry with no identity is dropped, not given a fabricated id", () => {
  assert.equal(toCatalogItem("pack", { description: "no name" }), null);
  assert.equal(toCatalogItem("mcp", {}), null);
});

test("mapResponse reports a shape mismatch instead of an empty list", () => {
  const bad = mapResponse("mcp", { notServers: [] });
  assert.deepEqual(bad.items, []);
  assert.match(bad.error, /servers/);

  const nonObj = mapResponse("mcp", null);
  assert.ok(nonObj.error);
});

test("mapResponse maps each species' own list key", () => {
  const mcp = mapResponse("mcp", { servers: [{ name: "a", description: "d" }] });
  assert.equal(mcp.items.length, 1);
  assert.equal(mcp.error, null);

  const pack = mapResponse("pack", { plugins: [{ name: "p", description: "d" }] });
  assert.equal(pack.items.length, 1);

  const anchor = mapResponse("data-anchor", { anchors: [{ id: "i", name: "n", kind: "k" }] });
  assert.equal(anchor.items.length, 1);
});

test("an empty source is an empty list with no error (honest zero)", () => {
  const r = mapResponse("facade", { facades: [] });
  assert.deepEqual(r.items, []);
  assert.equal(r.error, null, "an empty source is not an error");
});

test("source_absent is reported separately from an empty list", () => {
  // 「源没接入本部署」与「这一类确实 0 条」必须可区分——混成一句会把
  // 一个配置故障说成正常状态。
  const absent = mapResponse("facade", { facades: [], source_absent: true });
  assert.equal(absent.items.length, 0);
  assert.equal(absent.sourceAbsent, true);

  const genuinelyEmpty = mapResponse("facade", { facades: [] });
  assert.equal(genuinelyEmpty.sourceAbsent, false, "no flag means the source IS wired and returned zero");
});

test("an endpoint that carries no source_absent key is not guessed", () => {
  // mcp-catalog 的响应只有 servers，没有 source_absent。不能因此就说「源未接入」，
  // 也不能说「有内容」——只是不知道。
  const r = mapResponse("mcp", { servers: [] });
  assert.equal(r.sourceAbsent, false);
  assert.equal(r.error, null);
});

test("only pack declares an in-place detail", () => {
  const pack = toCatalogItem("pack", { name: "p" });
  assert.equal(pack.detail, true);
  for (const [species, raw] of [
    ["mcp", { name: "m" }],
    ["skill", { name: "s" }],
    ["facade", { id: "f" }],
    ["data-anchor", { id: "a", kind: "k" }],
  ]) {
    assert.equal(toCatalogItem(species, raw).detail, false, `${species} has no pack-style detail`);
  }
});


// ── 数据锚的分层（facet-catalog-species-curation 2.3）───────────────────────
//
// 目录默认只列数据源，指标折起来。这里钉住三件事：
//   1. 只有数据锚会被切；其他物种原样返回；
//   2. 切分不丢条目（源 + 指标 == 全部），否则「折叠」就变成了「删数据」；
//   3. 未标 kind 的条目算源——宁可多列一条，也不让真实数据在默认视图消失。
const mk = (id, kind) => ({ key: `anchor:${id}`, species: "data-anchor", id, title: id, summary: "", badges: kind ? [kind] : [], href: null, depth: false, detail: false });

test("splitAnchors: 只有数据锚会被切分", () => {
  const packs = [{ key: "pack:x", species: "pack", id: "x", title: "x", summary: "", badges: [], href: null, depth: false, detail: true }];
  assert.equal(splitAnchors("pack", packs), null);
  assert.equal(splitAnchors("all", packs), null);
  assert.ok(splitAnchors("data-anchor", packs));
});

test("splitAnchors: 源与指标分开，且一条都不丢", () => {
  const items = [mk("a", "source"), mk("b", "indicator"), mk("c", "source"), mk("d", "indicator")];
  const split = splitAnchors("data-anchor", items);
  assert.equal(split.sources.length, 2);
  assert.equal(split.indicators.length, 2);
  // 切分是划分，不是过滤：总数必须守恒。
  assert.equal(split.sources.length + split.indicators.length, items.length);
});

test("splitAnchors: 未标 kind 的条目算源，不在默认视图消失", () => {
  const split = splitAnchors("data-anchor", [mk("nokind", null), mk("i", "indicator")]);
  assert.deepEqual(split.sources.map((x) => x.id), ["nokind"]);
  assert.deepEqual(split.indicators.map((x) => x.id), ["i"]);
});

test("defaultView: 默认只列源，展开后全量", () => {
  const items = [mk("s", "source"), mk("i1", "indicator"), mk("i2", "indicator")];
  assert.deepEqual(defaultView("data-anchor", items).map((x) => x.id), ["s"]);
  assert.equal(defaultView("data-anchor", items, true).length, 3);
});

test("defaultView: 非数据锚物种原样返回（分层不外溢）", () => {
  const skills = [{ key: "skill:a", species: "skill", id: "a", title: "a", summary: "", badges: [], href: null, depth: true, detail: false }];
  assert.deepEqual(defaultView("skill", skills), skills);
});
