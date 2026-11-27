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

import { SPECIES_SPECS, specFor, fetchSpecies, toCatalogItem, mapResponse, needsAnotherPage, splitAnchors, defaultView, pickSlot, resolvePreviewRow } from "../facet/web/src/catalog-model.ts";

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

// 线上真实行（2026-11-24 `curl '/api/packs?limit=1&locale=en'` 原样抄下，
// 只保留断言用到的键）。用真形状而不是手搓形状：这一轮的缺陷正是「断言用的
// 形状不是生产给的那个」（旧实现读 marketplace.json 的 plugins，name 是 id）。
const REAL_PACK_ROW = {
  id: "O30LA92kq1D5uuNIBGKsZQ",
  name: "Vertical Constructor",
  description: "Blueprint Constructor: a three-post construction face — the architect compiles…",
  version: 32,
  lineLabel: "Base · Agent Teams",
  line: "壹座 · 智能体团队",
  display: {
    identity: { mark: { kind: "glyph", value: "蓝" }, accent: "base" },
    promise: "Compile natural language into a publishable team blueprint",
    audience: ["ops"],
    outcomes: [
      { title: "Blueprint drafts", detail: "Compile prose into a blueprint" },
      { title: "Sections and roster", detail: "Section boundaries, sources, roster" },
    ],
  },
};

test("pack card carries the pack's name, never its id", () => {
  const item = toCatalogItem("pack", REAL_PACK_ROW, "en");
  // 旧实现读 marketplace.json，title 就是 O30LA92kq1D5uuNIBGKsZQ —— 这条断言在旧实现下必红。
  assert.equal(item.title, "Vertical Constructor");
  assert.notEqual(item.title, REAL_PACK_ROW.id);
  assert.equal(item.summary, REAL_PACK_ROW.display.promise);
  assert.deepEqual(item.badges, ["Base · Agent Teams", "Blueprint drafts"]);
  assert.equal(item.mark, "蓝", "作者声明的印章字块要被带出来");
  // 目录页就地打开详情，不再链到 #/packs（catalog-owns-browse-market-owns-trade D2）
  assert.equal(item.detail, true);
  assert.equal(item.href, null, "pack must not link out; the detail opens in place");
});

test("pack without a promise falls back to the description's first sentence", () => {
  const item = toCatalogItem("pack", { id: "p1", name: "No Promise", description: "First sentence here. Second one." });
  assert.equal(item.summary, "First sentence here.");
});

test("a pack row with no name is dropped, not titled by its id", () => {
  assert.equal(toCatalogItem("pack", { id: "p1", description: "x" }), null);
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

  const pack = mapResponse("pack", { total: 1, packs: [{ id: "p", name: "P", description: "d" }] });
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
  const pack = toCatalogItem("pack", { id: "p", name: "p" });
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

// ── 卡片可判断性（polish-facet-mcp-surface 2.1）─────────────────────────────
//
// 卡片要在不打开深度视图的前提下可判断：规模（工具总数）与用途（whenToUse）。
// 两者都「有则显示、无则省略」——这里钉住的是缺席那一半：源没给时模型里必须是
// null / undefined，不能补成 0 或一句套话，否则「1 个工具」与「未知」看起来一样。
test("mcp 卡片带上工具总数与 whenToUse", () => {
  const item = toCatalogItem("mcp", {
    name: "fd-daas-mcp",
    description: "d",
    toolCount: 161,
    annotation: { name: "数据即服务", summary: "s", whenToUse: "不知道该用哪个专用服务时。" },
  });
  assert.equal(item.toolCount, 161);
  assert.equal(item.whenToUse, "不知道该用哪个专用服务时。");
});

test("mcp 卡片：只有其一时另一项缺席，不编造", () => {
  const onlyCount = toCatalogItem("mcp", { name: "x", description: "d", toolCount: 5 });
  assert.equal(onlyCount.toolCount, 5);
  assert.equal(onlyCount.whenToUse, undefined);

  const onlyWhen = toCatalogItem("mcp", { name: "y", description: "d", annotation: { whenToUse: "做某事时。" } });
  assert.equal(onlyWhen.toolCount, null, "no count is null, never 0");
  assert.equal(onlyWhen.whenToUse, "做某事时。");
});

test("mcp 卡片：非数字的 toolCount 读作未知", () => {
  for (const bad of ["161", null, {}, NaN, true]) {
    const item = toCatalogItem("mcp", { name: "w", description: "d", toolCount: bad });
    assert.equal(item.toolCount, null, `toolCount=${String(bad)}`);
  }
});

// ── locale 与分页（polish-facet-read-surfaces 2.1 / 1.3）────────────────────

test("locale 缺省时输出与改造前逐字节一致（兼容不变量）", () => {
  const row = { id: "f1", name: "寻数分身", description: "接待角色", annotation: {} };
  assert.deepEqual(toCatalogItem("facade", row), toCatalogItem("facade", row, "zh-CN"));
  assert.deepEqual(toCatalogItem("facade", row), toCatalogItem("facade", row, "zh"));
});

test("facade 卡按 locale 取五语 annotation", () => {
  // 线上 /api/facades-catalog 的真实形状：annotation.human 五语齐备。
  const row = {
    id: "packs-ut-x-reception",
    name: "寻数分身",
    description: "想了解寻数？和这个接待角色聊",
    annotation: {
      canonical: { brief: "zh brief" },
      human: {
        zh: { name: "寻数分身", summary: "想了解寻数？和这个接待角色聊" },
        en: { name: "FindData Twin", summary: "Meet FindData through a hosted reception persona" },
        ja: { name: "尋数の分身", summary: "説明" },
        es: { name: "Gemelo de FindData", summary: "x" },
        fr: { name: "Jumeau FindData", summary: "x" },
      },
    },
  };
  assert.equal(toCatalogItem("facade", row, "en").title, "FindData Twin");
  assert.equal(toCatalogItem("facade", row, "en").summary, "Meet FindData through a hosted reception persona");
  assert.equal(toCatalogItem("facade", row, "zh").title, "寻数分身");
  // 主子标签请求也能命中
  assert.equal(toCatalogItem("facade", row, "en-US").title, "FindData Twin");
});

test("annotation 缺失时退回顶层字段（现状不变）", () => {
  const item = toCatalogItem("facade", { id: "f1", name: "Top Name", description: "Top Desc" }, "en");
  assert.equal(item.title, "Top Name");
  assert.equal(item.summary, "Top Desc");
});

test("needsAnotherPage 只对分页物种生效，且按 total 判断", () => {
  assert.equal(needsAnotherPage("pack", { total: 142, packs: [] }, 100), true);
  assert.equal(needsAnotherPage("pack", { total: 142, packs: [] }, 142), false);
  assert.equal(needsAnotherPage("mcp", { servers: [] }, 0), false, "非分页物种不再取");
  assert.equal(needsAnotherPage("pack", { packs: [] }, 0), false, "没有 total 就不猜");
});

test("pack 物种读市场投影而不是 marketplace.json", () => {
  assert.equal(specFor("pack").endpoint, "/api/packs");
  assert.equal(specFor("pack").listKey, "packs");
  assert.equal(specFor("pack").paged, true);
});

// ── 分页取满（polish-facet-read-surfaces 1.3）───────────────────────────────
//
// 服务端每页上限 100，而 pack 今天有 142 条。取数循环由 total 决定页数，
// 不写死两页 —— 这里用一个两页假 fetch 钉住「请求数 = ceil(total/pageSize)」。

test("paged fetch takes every page the server declares", async () => {
  const pages = {
    1: { total: 142, page: 1, pageSize: 100, packs: Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, name: `P${i}` })) },
    2: { total: 142, page: 2, pageSize: 100, packs: Array.from({ length: 42 }, (_, i) => ({ id: `q${i}`, name: `Q${i}` })) },
  };
  const seen = [];
  const fetchImpl = async (url) => {
    const page = Number(new URL(url, "http://x").searchParams.get("page") || 1);
    seen.push(page);
    return { ok: true, json: async () => pages[page] };
  };
  const { items, requests } = await fetchSpecies("pack", { base: "", fetchImpl, locale: "en" });
  assert.equal(items.length, 142);
  assert.deepEqual(seen, [1, 2], "store fetches exactly the pages the total requires");
  assert.equal(requests, 2);
});

test("a single-page species issues one request and no page param", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ servers: [{ name: "m", description: "d" }] }) };
  };
  const { items, requests } = await fetchSpecies("mcp", { base: "", fetchImpl, locale: "zh-CN" });
  assert.equal(requests, 1);
  assert.equal(items.length, 1);
  assert.ok(!urls[0].includes("page="), `unpaged species must not carry a page param: ${urls[0]}`);
});

// ── 同一个包两个面同一句话（polish-facet-read-surfaces 1.4）──────────────────
//
// 市场卡的摘要是服务端 annotatePack 的 `display.promise || description`；
// 目录卡必须从同一份行读出同一句。这条断言是「一个材料一个名字一句话」的闸。
test("the same pack row reads identically in catalog and market", () => {
  const row = REAL_PACK_ROW;
  const card = toCatalogItem("pack", row, "en");
  const marketSummary = (row.display?.promise || "").trim() || row.description;
  assert.equal(card.title, row.name);
  assert.equal(card.summary, marketSummary);
});

// ── 预览行两代形状（polish-facet-read-surfaces 7.2）──────────────────────────
//
// 旧产物里 preview 行是字符串，新产物是五语槽。读取器两代都认，所以出片与
// 前端上线的先后顺序不致命（先发任一边都不会白屏）。
test("preview 行两代形状都能读出字符串", () => {
  const legacy = { name: "旧形状", blurb: "一句话" };
  assert.deepEqual(resolvePreviewRow(legacy, "en"), { name: "旧形状", blurb: "一句话" });

  const modern = {
    name: { "zh-CN": "蓝图构造师", en: "Vertical Constructor" },
    blurb: { "zh-CN": "编译蓝图", en: "Compile a blueprint" },
    badge: { "zh-CN": "官方", en: "Official" },
  };
  assert.deepEqual(resolvePreviewRow(modern, "en"), {
    name: "Vertical Constructor",
    blurb: "Compile a blueprint",
    badge: "Official",
  });
  assert.deepEqual(resolvePreviewRow(modern, "zh-CN"), { name: "蓝图构造师", blurb: "编译蓝图", badge: "官方" });
});

test("缺该语言的槽时退回 zh 主轨，绝不返回对象", () => {
  const row = { name: { "zh-CN": "只有中文" }, blurb: { "zh-CN": "只有中文的一句" } };
  assert.equal(pickSlot(row.name, "es"), "只有中文");
  assert.equal(pickSlot(row.name, "zh"), "只有中文");
  assert.equal(typeof pickSlot(row.name, "fr"), "string");
});

test("槽完全缺失时得到空串，不是 undefined", () => {
  assert.equal(pickSlot(undefined, "en"), "");
  assert.equal(pickSlot({}, "en"), "");
});

// ── 上游没给描述时的标记（2026-11-25 真机走查）────────────────────────────────
//
// registry AgentCard 里 6 支的 description 是空串。空白卡片会被读成
// 「查过了是空的」，而真相是「还没人写」。纯函数不产出文案（它没有 i18n），
// 只立一个标记，由渲染层用当前语言说。
test("没有描述的 facade 立 undescribed 标记，不编造说明", () => {
  const item = toCatalogItem("facade", {
    id: "packs-x-agent",
    name: "某 agent",
    description: "",
    deployment: { state: "undeployed" },
    annotation: { human: { zh: { name: "某 agent", summary: "" }, en: { name: "Some agent", summary: "" } } },
  }, "en");
  assert.equal(item.summary, "", "不编造一句话");
  assert.equal(item.undescribed, true);
  assert.equal(item.notRunning, true, "未部署的标记仍在");
});

test("有描述的 facade 不带 undescribed 标记", () => {
  const item = toCatalogItem("facade", {
    id: "f1", name: "有说明", description: "它做某件事",
    deployment: { state: "serving" },
    annotation: { human: { zh: { name: "有说明", summary: "它做某件事" } } },
  }, "zh");
  assert.equal(item.summary, "它做某件事");
  assert.equal(item.undescribed, undefined, "有说明时不该带这个标记");
});
