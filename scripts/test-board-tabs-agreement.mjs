// ── Board tabs: one source of truth (unify-line-board-tabs 5.1) ─────────────
//
//   node --test scripts/test-board-tabs-agreement.mjs
//
// 钉住的契约：
//   · 页签集合由适配器块声明派生：去重、首现顺序，无 tab 的块不贡献页签；
//   · 未连接态只出连接卡（单页签）——页面不渲染页签条；
//   · 页面**没有**第二份手写页签表：源码里不得再出现 `const TABS`，
//     必须从回包里取（这是 lex 四页签没上线的那个 bug 的根因）。
//
// 不联网：未连接态适配器都在取数前返回。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

process.env.LINE_BOARDS_ENABLED = "1";

const { tabsOfBlocks, getBoardAdapter, listBoardLines } = await import("../lib/board-adapters.js");

const PAGE = path.resolve(import.meta.dirname, "..", "web/src/pages/BoardsPage.tsx");

test("tabs derive from blocks: deduped, first-appearance order, tab-less ignored", () => {
  assert.deepEqual(
    tabsOfBlocks([
      { id: "a", tab: "overview" },
      { id: "b", tab: "my-packs" },
      { id: "c", tab: "overview" },
      { id: "d", tab: "publish-history" },
    ]),
    ["overview", "my-packs", "publish-history"],
  );
  assert.deepEqual(tabsOfBlocks([{ id: "legacy-no-tab" }]), [], "tab-less blocks add no tab");
  assert.deepEqual(tabsOfBlocks([]), []);
  assert.deepEqual(tabsOfBlocks([{ tab: "  " }, { tab: "overview" }]), ["overview"], "blank tab names ignored");
});

test("every registered line derives its own tabs from its own blocks", async () => {
  const lines = listBoardLines();
  assert.ok(lines.length >= 4, `expected the four onboarded lines, got ${lines.join(",")}`);
  for (const line of lines) {
    const adapter = getBoardAdapter(line);
    assert.ok(adapter, `${line} has an adapter`);
    const result = await adapter.fetchBlocks({ email: null });
    const blocks = result.blocks ?? [];
    const tabs = tabsOfBlocks(blocks);
    const whollyBuilding = blocks.length > 0 && blocks.every((b) => b.error === "under_construction");

    // A not-connected line shows the connection card alone — claiming several
    // tabs there would page through the same card. A wholly-under-construction
    // line may declare tabs (the adapter still knows its shape); the page
    // collapses those into one statement instead of a strip.
    if (result.connected === false) {
      assert.ok(tabs.length <= 1, `${line}: unconnected board must not claim ${tabs.length} tabs (${tabs.join(",")})`);
    }
    if (whollyBuilding) {
      assert.ok(tabs.length >= 1, `${line}: an under-construction line still declares its shape`);
    }
    for (const tab of tabs) {
      assert.equal(blocks.some((b) => b.tab === tab), true, `${line}: tab ${tab} must be backed by a block`);
    }
  }
});

test("the page keeps no second tab table", () => {
  const src = fs.readFileSync(PAGE, "utf8");
  assert.equal(/const\s+TABS\s*:/.test(src), false, "no hand-written TABS table in the page");
  assert.ok(src.includes("data.tabs") || src.includes("tabsOf(data)"), "tabs come from the response");
});

test("the page collapses a wholly-under-construction line into one statement", () => {
  const src = fs.readFileSync(PAGE, "utf8");
  assert.ok(src.includes("whollyUnderConstruction"), "the whole-line predicate exists");
  assert.ok(src.includes("board-line-construction"), "the collapsed state has a test id");
  // The collapse must be driven by the sentinel, not by a line name.
  assert.equal(/line\s*===\s*["']wanxing["']/.test(src), false, "no per-line special case");
});

// ── page policy: pure functions, imported directly (no DOM needed) ──────────
const policy = await import("../web/src/lib/boardTabs.ts");

test("a wholly under-construction line collapses; a partly-built one keeps its strip", () => {
  const building = [{ id: "a", error: "under_construction" }, { id: "b", error: "under_construction" }];
  const mixed = [{ id: "a", data: { x: 1 } }, { id: "b", error: "under_construction" }];

  assert.equal(policy.whollyUnderConstruction(building), true);
  assert.equal(policy.showsTabStrip(building, ["a", "b"]), false, "no strip for a line with nothing to show");

  assert.equal(policy.whollyUnderConstruction(mixed), false, "one real block means the line is alive");
  assert.equal(policy.showsTabStrip(mixed, ["a", "b"]), true, "the strip returns as soon as one tab is real");

  assert.equal(policy.whollyUnderConstruction([]), false, "an empty board is not 'all building'");
  assert.equal(policy.showsTabStrip([], ["only"]), false, "a single tab renders no strip");
});

test("base is classified as the host line, not an un-onboarded line", () => {
  assert.equal(policy.HOST_LINES.has("base"), true);
  for (const line of ["facet", "lex", "wire", "wanxing"]) {
    assert.equal(policy.HOST_LINES.has(line), false, `${line} is an external line with its own board`);
  }
});

test("tabsOf tolerates a response without tabs (older adapter, error shape)", () => {
  assert.deepEqual(policy.tabsOf({ tabs: ["overview", "billing"] }), ["overview", "billing"]);
  assert.deepEqual(policy.tabsOf({}), [], "missing tabs renders no strip rather than inventing one");
  assert.deepEqual(policy.tabsOf(null), []);
});
