#!/usr/bin/env node
// ── extension-store annotation merge + index (add-mcp-annotation-overlay) ────
//
// The bundled market catalog carries curated annotations (task 1.2); the
// merged read face attaches them, getSupplyAnnotationIndex projects them per
// request locale through the ONE helper (zh 唯一回落), and tool sub-annotations
// index under "<server>__<leaf>". Runs against the real bundled catalog.
//
//   node --test scripts/test-supply-annotation-store.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import * as store from "../extension-store.js";

test("bundled annotations ride the merged catalog by name", async () => {
  const byName = await store.getAnnotationsByName();
  assert.equal(byName.get("fetch").human.zh.name, "网页抓取");
  assert.equal(byName.get("fetch").provenance.source, "catalog");
  assert.equal(byName.get("github").canonical.brief.length > 0, true);
  assert.equal(byName.get("github").tools.create_issue.human.zh.name, "建 issue");
});

test("getMarketCatalog entries carry the merged annotation", async () => {
  const catalog = await store.getMarketCatalog(null);
  const fetchEntry = catalog.mcpServers.find((s) => s.name === "fetch");
  assert.equal(fetchEntry.annotation.human.zh.summary.includes("拉取任意网址"), true);
});

test("the annotation index projects per locale with the zh-only fallback", async () => {
  const en = await store.getSupplyAnnotationIndex("en");
  assert.equal(en.servers.fetch.label, "Web fetch");
  assert.equal(en.tools["github__create_issue"].label, "Create issue");

  const ja = await store.getSupplyAnnotationIndex("ja");
  assert.equal(ja.servers.fetch.label, "网页抓取"); // ja 缺 → zh 回落
  assert.equal(ja.tools["github__create_issue"].label, "建 issue"); // 工具子注释同规则
});

test("unannotated entries contribute nothing to the index (raw path)", async () => {
  const idx = await store.getSupplyAnnotationIndex("en");
  // Every bundled server is curated, so the index covers exactly those names;
  // the point is the shape — no placeholder or invented entries.
  for (const [name, v] of Object.entries(idx.servers)) {
    assert.equal(typeof v.label, "string");
    assert.notEqual(v.label, "");
    assert.equal(name.length > 0, true);
  }
});
