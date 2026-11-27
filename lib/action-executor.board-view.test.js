// Tests for the board-view action handlers (openspec: unify-copilot-workbench 2.7/2.8).
// Run: node --test lib/action-executor.board-view.test.js
//
// These actions are the only writes the copilot can make on a board, and their
// safety argument is "they touch nothing but this user's own view". That claim
// is what these tests check: the stored preference is the ONLY effect, the
// shape is validated, and an out-of-range or impossible target is refused
// rather than silently trimmed.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "board-view-")), "app.db");

const db = await import("../db.js");
await db.initDb();
const { applyBoardView, resetBoardView } = await import("./board-view-store.js");
const { getAction, tierForRisk, listActions } = await import("./action-registry.js");
const { MAX_VIEW_BLOCKS } = await import("./board-adapters.js");

const KEY = (line) => `board.view.${line}`;

test("2.7 both verbs are registered at the write tier and host no tool", () => {
  for (const id of ["board.view.set", "board.view.reset"]) {
    const a = getAction(id);
    assert.ok(a, `${id} must be registered`);
    assert.equal(a.risk, "write");
    assert.equal(tierForRisk(a.risk), "inline");
    // No tool = the executor's local-handler branch. A tool name here would
    // route it to a line MCP server that has no such verb.
    assert.equal(a.tool, undefined);
    // Not a line action: `listActions({line})` must never return it, or the
    // focused-preset resolver would treat "local" as a line's server.
    assert.equal(a.line, null);
  }
  for (const line of ["facet", "wanxing", "wire", "lex"]) {
    assert.equal(listActions({ line }).some((a) => a.id.startsWith("board.view.")), false);
  }
});

test("2.8 set stores the view; only the preference row changes", async () => {
  db.setPreference(KEY("facet"), null);
  const before = JSON.stringify(db.getAllPreferences());
  const out = await applyBoardView({
    args: {
      line: "facet",
      view: [
        { blockId: "publish_history", tab: "mine", order: 0 },
        { blockId: "my_packs", tab: "mine", order: 1 },
      ],
    },
  });
  assert.match(out.summary, /facet/);
  assert.deepEqual(JSON.parse(db.getPreference(KEY("facet"))).map((e) => e.blockId), [
    "publish_history",
    "my_packs",
  ]);
  // The summary names a line the caller can refresh on.
  assert.equal(out.changed.line, "facet");
  // No OTHER preference appeared: the effect is exactly one key.
  const after = JSON.parse(JSON.stringify(db.getAllPreferences()));
  delete after[KEY("facet")];
  const beforeObj = JSON.parse(before);
  delete beforeObj[KEY("facet")];
  assert.deepEqual(after, beforeObj);
});

test("2.8 an empty view means reset, not an empty board", async () => {
  db.setPreference(KEY("facet"), JSON.stringify([{ blockId: "my_packs", order: 0 }]));
  await applyBoardView({ args: { line: "facet", view: [] } });
  assert.equal(db.getPreference(KEY("facet")), null, "cleared, so the default view renders");
});

test("2.8 reset clears the key", async () => {
  db.setPreference(KEY("wire"), JSON.stringify([{ blockId: "x", order: 0 }]));
  const out = await resetBoardView({ args: { line: "wire" } });
  assert.match(out.summary, /默认/);
  assert.equal(db.getPreference(KEY("wire")), null);
});

test("2.8 an oversized view is refused, not truncated", async () => {
  const view = Array.from({ length: MAX_VIEW_BLOCKS + 1 }, (_, i) => ({ blockId: `b${i}`, order: i }));
  await assert.rejects(() => applyBoardView({ args: { line: "facet", view } }), /最多/);
  // Refusing must not leave a partial write behind.
  assert.equal(db.getPreference(KEY("facet")), null);
});

test("2.8 an unknown line is refused", async () => {
  await assert.rejects(() => applyBoardView({ args: { line: "no-such-line", view: [{ blockId: "a" }] } }), /未知的看板线/);
  await assert.rejects(() => resetBoardView({ args: { line: "" } }), /缺少看板线/);
});

test("2.8 a malformed entry is refused and nothing is written", async () => {
  db.setPreference(KEY("facet"), null);
  await assert.rejects(() => applyBoardView({ args: { line: "facet", view: [{ order: 0 }] } }), /缺少 blockId/);
  await assert.rejects(() => applyBoardView({ args: { line: "facet", view: ["nope"] } }), /不是对象/);
  await assert.rejects(() => applyBoardView({ args: { line: "facet" } }), /缺少 view/);
  assert.equal(db.getPreference(KEY("facet")), null);
});

test("2.8 a duplicate block renders once — the first occurrence's order wins", async () => {
  await applyBoardView({
    args: {
      line: "facet",
      view: [
        { blockId: "my_packs", order: 5 },
        { blockId: "my_packs", order: 0 },
      ],
    },
  });
  const stored = JSON.parse(db.getPreference(KEY("facet")));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].order, 5);
});

test("2.8 a chart entry keeps its resourceId; the stray keys do not survive", async () => {
  await applyBoardView({
    args: {
      line: "facet",
      view: [{ blockId: "chart:r1", resourceId: "r1", tab: "overview", title: "销量", evil: "x", order: 0 }],
    },
  });
  const stored = JSON.parse(db.getPreference(KEY("facet")));
  assert.deepEqual(stored, [{ blockId: "chart:r1", tab: "overview", order: 0, resourceId: "r1", title: "销量" }]);
  assert.equal("evil" in stored[0], false, "undeclared keys are dropped, not stored");
});
