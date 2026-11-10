// ── Adopted provenance display tests (add-official-adopted-agents 3.2) ───────
//
// 展示面的契约（不是重新推导，而是**读同一投影**）：
//   官方精选·已审校 出现当且仅当 roster 官方 ∧ manifest 声明 adopted。
//   两者缺一都不出这个标记：
//     - 只有 roster（官方原创）  → 出「官方」，不出 adopted
//     - 只有 adopted（社区携带） → 什么都不出（且不下发 provenance 键）
//
// 同时钉住：facet 的清单（marketplace.json）与平台面用同一判定，且**不改变**
// curated 准入与排序 —— 这是 ecosystem-curation 明令的边界。
//
//   node --test scripts/test-adoption-display.mjs

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

const mod = await import("../facet/marketplace-json.js");

// 假 registry：只实现 loadListedPacks 需要的 list()。每行自带 official/adopted
// 投影字段，模拟 gateway 的 SQL 投影输出。
function fakeRegistry(rows) {
  return {
    list({ page = 1, pageSize = 100 } = {}) {
      const start = (page - 1) * pageSize;
      const slice = rows.slice(start, start + pageSize);
      return { packs: slice, total: rows.length };
    },
  };
}

// 真实契约（本轮真机走查修正）：registry.list() 的 summary **不含 official** ——
// 它由路由层按部署 roster 注入。所以这里的行只带 SQL 投影字段（adopted），
// official 由 registerMarketplaceJson 自己按 officialAuthors 判定。
const OFFICIAL = "publisher@finddatatech.cloud";
const COMMUNITY = "someone@example.com";

function row(id, { official = false, adopted = false, category = "data", featured = false } = {}) {
  return {
    id,
    version: 1,
    name: id,
    description: `${id} desc`,
    category,
    featured,
    authorEmail: official ? OFFICIAL : COMMUNITY,
    // adopted 是 registry 的 SQL 投影（is_adopted）；official 故意不放在行上，
    // 谁把它放上来谁就绕过了 roster——本文件正是钉这条。
    adopted,
  };
}

// 挂一个只读镜像的 app，取 marketplace.json 的 plugins。roster 与部署一致时
// 行上的 authorEmail 才读作官方。
async function fetchPlugins(rows, { officialAuthors = [OFFICIAL] } = {}) {
  const app = express();
  mod.registerMarketplaceJson(app, { registry: fakeRegistry(rows), resolveUser: () => null, officialAuthors });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.on("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/marketplace.json`);
    return (await res.json()).plugins;
  } finally {
    server.close();
  }
}

test("display: official + adopted renders the adopted provenance mark", async () => {
  const plugins = await fetchPlugins([row("a", { official: true, adopted: true })]);
  assert.deepEqual(plugins[0].provenance, { source: "official-adopted" });
});

test("display: official-original carries NO adopted mark (three kinds stay distinguishable)", async () => {
  const plugins = await fetchPlugins([row("b", { official: true, adopted: false })]);
  assert.equal(plugins[0].provenance, undefined);
});

test("display: an adopted record without the roster grants nothing (community stays community)", async () => {
  const plugins = await fetchPlugins([row("c", { official: false, adopted: true })]);
  assert.equal(plugins[0].provenance, undefined, "manifest self-declaration must never read as official");
});

test("display: legacy rows are byte-identical (no provenance key at all)", async () => {
  const plugins = await fetchPlugins([row("d"), row("e", { featured: true })]);
  for (const p of plugins) {
    assert.equal("provenance" in p, false);
  }
  // 与改动前的字段集合逐键相同（顺序无关比较键集）
  assert.deepEqual(
    Object.keys(plugins[0]).sort(),
    ["author", "category", "description", "featured", "name", "source", "version"],
  );
});

test("display: admission and ordering are untouched by provenance", async () => {
  // 未 curated（无 category、非 featured）的条目，即使 official+adopted 也不进清单
  const plugins = await fetchPlugins([
    row("listed", { category: "data" }),
    row("unlisted", { category: "", featured: false, official: true, adopted: true }),
  ]);
  const ids = plugins.map((p) => p.name);
  assert.deepEqual(ids, ["listed"], "curation admission must not be widened by provenance");
});

test("display: provenance does not reorder the curated list", async () => {
  const rows = [row("x", { category: "data" }), row("y", { category: "data", official: true, adopted: true })];
  const plugins = await fetchPlugins(rows);
  assert.deepEqual(plugins.map((p) => p.name), ["x", "y"], "registry order is preserved verbatim");
});
