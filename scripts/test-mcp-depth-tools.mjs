#!/usr/bin/env node
// ── MCP depth tool-surface tests (polish-facet-catalog-depth 1.1/1.2/2.1-2.3/3.1) ─
//
// Three legs, per the repo convention (test-workspace-canvas /
// test-market-locale-refetch precedent): the pure helpers (grouping / filter /
// preview heuristic) are unit-tested here directly; the component wiring
// (fetch locale params + deps refetch, raw-name contract) is pinned as a
// SOURCE contract because the repo ships no React component-test harness —
// the observable browser behavior (switch → refetch in the new locale) runs
// in e2e (facet-shell.spec.js) and the production walkthrough.
//
//   node --test scripts/test-mcp-depth-tools.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const { groupToolsByPrefix, filterTools, descriptionExceedsPreview } = await import(
  "../facet/web/src/mcpDepthTools.ts"
);

// ── 2.1 prefix grouping ──────────────────────────────────────────────────────

test("2.1 grouping: prefixed tools bucket by first segment; groups sort alphabetically; other bucket lands last", () => {
  const tools = [
    tool("compute_rows"),
    tool("alerts_list"),
    tool("compute_cols"),
    tool("alerts_get"),
    tool("solo_prefix_tool"), // single-member prefix group → folds to 其他
    tool("nonameseparator"), // no underscore → 其他
    tool("compute_sum"),
  ];
  const groups = groupToolsByPrefix(tools);
  assert.deepEqual(
    groups.map((g) => g.prefix),
    ["alerts", "compute", null],
  );
  const alerts = groups[0];
  assert.equal(alerts.tools.length, 2);
  assert.deepEqual(alerts.tools.map((t) => t.name), ["alerts_list", "alerts_get"]); // registry order preserved
  const other = groups[groups.length - 1];
  assert.ok(other.prefix === null, "other bucket is the tail group");
  assert.deepEqual(
    other.tools.map((t) => t.name).sort(),
    ["nonameseparator", "solo_prefix_tool"].sort(),
  );
});

test("2.1 grouping: 193-scale wire-cell-shaped fixture — every tool lands in exactly one group", () => {
  // Wire-cell-shaped synthetic corpus: 8 wire prefixes × ~24 tools + a tail of
  // loners (single-member prefixes and underscore-free names) — the same
  // shape the production 193-tool surface has.
  const prefixes = ["alerts", "compute", "context", "dispatch", "events", "fleet", "guard", "health"];
  const tools = [];
  for (const p of prefixes) for (let i = 0; i < 24; i++) tools.push(tool(`${p}_${String(i).padStart(2, "0")}`));
  tools.push(tool("loner_tool"), tool("orphan_tool"), tool("barename"));
  const groups = groupToolsByPrefix(tools);
  assert.equal(groups.length, 9); // 8 prefix groups + 1 其他 bucket
  assert.equal(groups[groups.length - 1].prefix, null);
  assert.equal(groups[groups.length - 1].tools.length, 3);
  const total = groups.reduce((n, g) => n + g.tools.length, 0);
  assert.equal(total, tools.length); // no tool lost, no tool duplicated
  for (const g of groups.slice(0, -1)) assert.ok(g.tools.length >= 2, "no single-member prefix group survives");
});

test("2.1 grouping: an all-loner surface yields ONLY the other bucket (count still honest)", () => {
  const groups = groupToolsByPrefix([tool("read"), tool("search")]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].prefix, null);
  assert.equal(groups[0].tools.length, 2);
});

// ── 2.2 client-side filter ───────────────────────────────────────────────────

test("2.2 filter: hit / miss / case-insensitive / empty-restores — all four states", () => {
  const tools = [
    tool("compute_rows", "Sum two numbers."),
    tool("alerts_get", "", { name: "取告警", summary: "读取一条告警。" }),
    tool("bare_tool", "Purge an entry."),
  ];
  // hit — raw name
  assert.deepEqual(filterTools(tools, "rows").map((t) => t.name), ["compute_rows"]);
  // hit — case-insensitive raw description
  assert.deepEqual(filterTools(tools, "PURGE").map((t) => t.name), ["bare_tool"]);
  // hit — annotation label and annotation summary both match
  assert.deepEqual(filterTools(tools, "取告警").map((t) => t.name), ["alerts_get"]);
  assert.deepEqual(filterTools(tools, "告警。").map((t) => t.name), ["alerts_get"]);
  // miss
  assert.deepEqual(filterTools(tools, "nothing-matches"), []);
  // empty / whitespace-only restores the full list (same array)
  assert.equal(filterTools(tools, ""), tools);
  assert.equal(filterTools(tools, "   "), tools);
});

// ── 2.3 preview heuristic ────────────────────────────────────────────────────

test("2.3 preview heuristic: long or many-lined text folds; short single-line text never does", () => {
  assert.equal(descriptionExceedsPreview("x".repeat(161)), true);
  assert.equal(descriptionExceedsPreview("x".repeat(160)), false);
  assert.equal(descriptionExceedsPreview("one\nshort\ntext"), false);
  assert.equal(descriptionExceedsPreview("a\nb\nc\nd\ne"), true); // 5 hard breaks → folds
  assert.equal(descriptionExceedsPreview(""), false);
});

// ── 1.1 source contract: locale-wired fetches ────────────────────────────────
// The repo ships no React component harness; the wiring is pinned on source
// (same discipline as test-workspace-canvas) and the observable refetch runs
// in e2e + 真机.

test("1.1 source contract: all three catalog fetches carry ?locale= with locale in deps", () => {
  const src = read("facet/web/src/McpCatalog.tsx");
  assert.match(src, /fetch\(`\/api\/mcp-catalog\?locale=\$\{locale\}`\)/, "list fetch carries locale");
  assert.match(
    src,
    /fetch\(`\/api\/mcp-catalog\/\$\{encodeURIComponent\(name\)\}\?locale=\$\{locale\}`\)/,
    "depth fetch carries locale",
  );
  assert.match(src, /fetch\(`\/api\/skills-catalog\?locale=\$\{locale\}`\)/, "skills fetch carries locale");
  assert.match(src, /useLanguage\(\)/, "locale comes from the surface's own locale selection");
  // every catalog effect re-runs when the locale flips
  const deps = [...src.matchAll(/\}, \[locale\]\)|\}, \[name, locale\]\)/g)];
  assert.equal(deps.length, 3, "all three useEffect deps include locale");
});

test("2.3 source contract: raw name always renders (mono, never replaced) and the grid/clamp classes ride the tool cards", () => {
  const src = read("facet/web/src/McpCatalog.tsx");
  assert.match(src, /font-mono[^>]*>\{tool\.name\}/, "raw tool name renders in mono");
  assert.match(src, /sm:grid-cols-2 xl:grid-cols-3/, "responsive 1/2/3-column grid");
  assert.match(src, /line-clamp-4/, "clamped preview");
  assert.match(src, /max-w-6xl/, "content column max-width");
  assert.match(src, /annotation\?\.summary \?\? ""/, "annotation summary leads, raw text is the fallback");
});

// ── 1.2 five-locale key coverage gate ────────────────────────────────────────

test("1.2 i18n gate: all five locale files carry the five new mcp.depth keys, filled in their own language", () => {
  const keys = ["groupOther", "filterPlaceholder", "expand", "collapse", "noResults"];
  for (const locale of ["zh-CN", "en", "es", "fr", "ja"]) {
    const depth = JSON.parse(read(`web/src/locales/${locale}/common.json`)).mcp.depth;
    for (const key of keys) {
      assert.equal(typeof depth[key], "string", `${locale}.${key} present`);
      assert.ok(depth[key].trim().length > 0, `${locale}.${key} non-empty`);
    }
  }
  // en 门: the en values must be actual English, not zh passthrough.
  const en = JSON.parse(read("web/src/locales/en/common.json")).mcp.depth;
  assert.equal(en.groupOther, "Other");
  assert.equal(en.noResults, "No matching tools.");
});

function tool(name, description = "d", annotation = undefined) {
  return { name, description, annotation };
}
