#!/usr/bin/env node
// ── 类目→线归位展示映射 tests (add-legacy-pack-rebrand 2.x; spec: pack-category-line-mapping)
//
// Pins the three contract faces:
//   1. the mapping lib: mapped slug→line word, unmapped→itself (present-as-is),
//      facade/company→null (suppressed from the facet, badge carries them), env override,
//      isLineWord distinguishes a line selection from a raw-slug query
//   2. the read face: a facet selection carrying the LINE word expands to the slugs
//      it stands for; a raw-slug query still matches exactly; every row carries `line`
//   3. zero migration + write parity: the STORED category is untouched (install/
//      subscribe/visibility/badge unchanged) and the curation write still takes the
//      original slug
//
//   node --test scripts/test-category-line-mapping.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test } from "node:test";

const tmp = mkdtempSync(path.join(tmpdir(), "cat-line-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const {
  lineOf,
  slugsForLine,
  isLineWord,
  facetLinesOf,
  categoryLines,
  _resetCategoryLinesCache,
} = await import("../lib/pack-category-lines.js");

// ── 1. mapping lib ───────────────────────────────────────────────────────────

const TEAM = "壹座 · 智能体团队";
const DATA = "柏讯 · 数据与情报";
const LEGAL = "识律 · 法律智能";
const FLOW = "谦面 · 业务流";
const CONNECT = "萬星 · 智能体连接";

test("lineOf: 现网 14 类目按五线归位，facade/company 剔除，未映射透传", () => {
  assert.equal(lineOf("cluster"), TEAM);
  assert.equal(lineOf("fleet"), TEAM);
  assert.equal(lineOf("fleet-shared"), TEAM);
  assert.equal(lineOf("wire"), DATA);
  assert.equal(lineOf("research"), DATA);
  assert.equal(lineOf("legal"), LEGAL);
  assert.equal(lineOf("facet"), FLOW);
  assert.equal(lineOf("text"), FLOW);
  assert.equal(lineOf("doc-studio"), FLOW);
  assert.equal(lineOf("crm"), FLOW);
  assert.equal(lineOf("operations"), FLOW);
  assert.equal(lineOf("business"), FLOW);
  assert.equal(lineOf("wanxing"), CONNECT);
  // 历史散类目向后兼容
  assert.equal(lineOf("daas"), DATA);
  assert.equal(lineOf("data"), DATA);
  assert.equal(lineOf("authoring"), FLOW);
  // 分身类由 badge=facade 承担
  assert.equal(lineOf("facade"), null, "facade suppressed — the facade badge carries it");
  assert.equal(lineOf("company"), null);
  assert.equal(lineOf("custom-xyz"), "custom-xyz", "unmapped category presents as-is");
  assert.equal(lineOf(""), "", "no category → no line");
  assert.equal(lineOf(undefined), "", "absent category → no line");
});

test("slugsForLine: many slugs collapse to one line word", () => {
  assert.deepEqual(slugsForLine(TEAM).sort(), ["cluster", "fleet", "fleet-shared"]);
  assert.deepEqual(slugsForLine(DATA).sort(), ["analytics", "daas", "dash", "data", "research", "wire"]);
  assert.deepEqual(slugsForLine(LEGAL), ["legal"]);
  assert.deepEqual(slugsForLine("不存在"), [], "a word no slug maps to → empty");
});

test("isLineWord: a line selection is expanded, a raw slug is matched exactly", () => {
  assert.equal(isLineWord(TEAM), true);
  assert.equal(isLineWord(DATA), true);
  assert.equal(isLineWord("wire"), false, "wire is a stored slug, not a line word — exact match");
  assert.equal(isLineWord("custom-xyz"), false, "unmapped slug is not a line word");
  assert.equal(isLineWord(""), false);
});

test("facetLinesOf: aggregates to sorted distinct line words, drops the null bucket", () => {
  assert.deepEqual(facetLinesOf(["wire", "research", "cluster", "facade", "custom-xyz"]), [
    "custom-xyz",
    TEAM,
    DATA,
  ], "wire+research collapse to one chip; facade dropped; unmapped passes through");
});

test("the table is deployment-configurable via PACK_CATEGORY_LINES (and falls back when malformed)", () => {
  _resetCategoryLinesCache();
  process.env.PACK_CATEGORY_LINES = JSON.stringify({ wire: "开放数据", facade: "公司", ml: null });
  assert.equal(lineOf("wire"), "开放数据");
  assert.equal(lineOf("facade"), "公司", "override can un-suppress facade");
  assert.equal(lineOf("ml"), null);
  assert.equal(lineOf("legal"), "legal", "slugs absent from the override present as-is (override REPLACES the table)");
  // malformed JSON → honest fallback to the built-in, never a broken face
  _resetCategoryLinesCache();
  process.env.PACK_CATEGORY_LINES = "{not json";
  assert.equal(lineOf("cluster"), TEAM);
  _resetCategoryLinesCache();
  delete process.env.PACK_CATEGORY_LINES;
  assert.equal(Object.keys(categoryLines()).length > 0, true);
  _resetCategoryLinesCache();
});

// ── 2 + 3. the read face ─────────────────────────────────────────────────────

const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");

const MANIFEST = (name) => ({
  name,
  description: `${name} 描述`,
  visibility: "public",
  tags: [],
  skills: [{ name: "s", description: "d", content: "# s" }],
});

function mount(reg) {
  const app = express();
  registerPackRoutes(app, {
    registry: reg,
    resolveUser: () => ({ email: "author@x", groups: [] }),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "Authentication required" }),
    creatorGroups: ["creators"],
  });
  const server = http.createServer(app);
  server.listen(0);
  return server;
}

function seed() {
  const reg = createPackRegistry({ file: path.join(mkdtempSync(path.join(tmp, "reg-")), "packs.db") });
  const ids = {};
  for (const slug of ["daas", "wire", "data", "company", "custom-xyz"]) {
    const p = reg.publish({ email: "author@x", manifest: MANIFEST(`包-${slug}`) });
    reg.setCuration({ id: p.id, actor: { email: "author@x", admin: true }, category: slug });
    ids[slug] = p.id;
  }
  return { reg, ids };
}

const listGet = async (server, qs) =>
  fetch(`http://127.0.0.1:${server.address().port}/api/packs${qs}`).then((r) => r.json());

test("a line-word facet selection expands to the slugs it stands for", async () => {
  const { reg } = seed();
  const server = mount(reg);
  try {
    const { packs } = await listGet(server, `?category=${encodeURIComponent(DATA)}`);
    assert.deepEqual(packs.map((p) => p.name).sort(), ["包-daas", "包-data", "包-wire"], "daas+data+wire return under one line");
  } finally {
    server.close();
  }
});

test("a raw-slug query still matches exactly (API clients unaffected by the mapping)", async () => {
  const { reg } = seed();
  const server = mount(reg);
  try {
    const { packs } = await listGet(server, "?category=daas");
    assert.deepEqual(packs.map((p) => p.name), ["包-daas"], "daas alone, not wire/data");
  } finally {
    server.close();
  }
});

test("every row carries `line` (its归位 word) while `category` stays the stored slug", async () => {
  const { reg } = seed();
  const server = mount(reg);
  try {
    const { packs } = await listGet(server, "");
    const byName = Object.fromEntries(packs.map((p) => [p.name, p]));
    assert.equal(byName["包-daas"].category, "daas", "stored value is byte-for-byte the slug");
    assert.equal(byName["包-daas"].line, DATA);
    assert.equal(byName["包-company"].category, "company");
    assert.equal(byName["包-company"].line, null, "company has no facet line");
    assert.equal(byName["包-custom-xyz"].line, "custom-xyz", "unmapped passes through");
  } finally {
    server.close();
  }
});

test("company/facade never appear as facet chips (badge carries 分身)", async () => {
  const { reg, ids } = seed();
  const server = mount(reg);
  try {
    const { packs } = await listGet(server, "");
    const facetSet = new Set(
      packs.map((p) => (p.line === undefined ? p.category : p.line) || "").filter(Boolean),
    );
    assert.equal(facetSet.has("company"), false, "the raw company slug must not resurface");
    assert.equal(facetSet.has(DATA), true);
    // and it is still installable/visible — the mapping is display-only
    assert.ok(ids.company, "the company pack still exists with its row");
  } finally {
    server.close();
  }
});

test("the curation WRITE still takes and stores the original slug (zero migration)", async () => {
  const { reg, ids } = seed();
  // re-write a mapped pack's category to a different raw slug — storage keeps the slug
  const res = reg.setCuration({ id: ids.daas, actor: { email: "author@x", admin: true }, category: "wire" });
  assert.equal(res.category, "wire", "write endpoint speaks slugs, not line words");
  const row = reg.list({ pageSize: 100 }).packs.find((p) => p.id === ids.daas);
  assert.equal(row.category, "wire");
  assert.equal(row.line, DATA, "and it re-projects to the same line word");
});
