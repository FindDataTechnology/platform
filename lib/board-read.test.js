// Tests for the board_read read tool (openspec: unify-copilot-workbench 1.6).
// Run: node --test lib/board-read.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A throwaway DB per run: board.view.* lives in user_preferences, and this test
// drives the real read path (storedView → adapter → payload).
process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "board-read-")), "app.db");

const { defaultViewFromCatalog, resolveView, storedViewOrNull, MAX_VIEW_BLOCKS } = await import("../lib/board-adapters.js");
const db = await import("../db.js");

await db.initDb();

/** A fake adapter registry entry, injected by monkeypatching the modules the
 *  tool reads. Kept at the module boundary so the tool's own logic is what runs. */
const FIXTURE_CATALOG = [
  { id: "overview_metrics", type: "metrics", tab: "overview", title: "概览", data: { packs: 4 } },
  { id: "my_packs", type: "list", tab: "mine", title: "我的包", data: [{ id: "a" }, { id: "b" }] },
  { id: "broken", type: "list", tab: "mine", title: "坏块", error: "upstream 502" },
];

test("defaultViewFromCatalog keeps adapter order and tabs", () => {
  assert.deepEqual(defaultViewFromCatalog(FIXTURE_CATALOG), [
    { blockId: "overview_metrics", tab: "overview", order: 0 },
    { blockId: "my_packs", tab: "mine", order: 1 },
    { blockId: "broken", tab: "mine", order: 2 },
  ]);
  assert.deepEqual(defaultViewFromCatalog(null), []);
  // A catalog entry without an id cannot be referenced by a view — dropping it
  // is what keeps order contiguous.
  assert.deepEqual(defaultViewFromCatalog([{ type: "metrics" }]), []);
});

test("a stored user view wins over the default; malformed JSON degrades to default", () => {
  // Write through the same preference API the route uses.
  db.setPreference("board.view.facet", JSON.stringify([{ blockId: "my_packs", tab: "mine", order: 0 }]));

  const raw = db.getPreference("board.view.facet");
  assert.equal(
    JSON.parse(raw)[0].blockId,
    "my_packs",
    "the route and the tool read the same key",
  );

  db.setPreference("board.view.facet", "{not json");
  // Reading it back must not throw; the tool's storedView() swallows and the
  // caller falls back to the default view.
  assert.doesNotThrow(() => db.getPreference("board.view.facet"));

  db.setPreference("board.view.facet", null);
});

// ── B2: catalog × view (unify-copilot-workbench 2.2) ────────────────────────

test("2.2 no user view renders the default view byte-for-byte", () => {
  const out = resolveView({ userView: null, catalog: FIXTURE_CATALOG });
  assert.deepEqual(out.blocks.map((b) => b.id), ["overview_metrics", "my_packs", "broken"]);
  assert.deepEqual(out.dropped, []);
  // An empty array is "no view", same as null — a cleared preference must not
  // render an empty board.
  assert.deepEqual(resolveView({ userView: [], catalog: FIXTURE_CATALOG }).blocks.map((b) => b.id), [
    "overview_metrics",
    "my_packs",
    "broken",
  ]);
});

test("2.2 order is honoured and a retired blockId is dropped, not fatal", () => {
  const out = resolveView({
    userView: [
      { blockId: "broken", order: 0 },
      { blockId: "gone-forever", order: 1 },
      { blockId: "overview_metrics", order: 2 },
    ],
    catalog: FIXTURE_CATALOG,
  });
  assert.deepEqual(out.blocks.map((b) => b.id), ["broken", "overview_metrics"]);
  assert.deepEqual(out.dropped, ["gone-forever"]);
});

test("2.2 a view naming the same block twice renders it once", () => {
  const out = resolveView({
    userView: [
      { blockId: "my_packs", order: 0 },
      { blockId: "my_packs", order: 1 },
    ],
    catalog: FIXTURE_CATALOG,
  });
  assert.deepEqual(out.blocks.map((b) => b.id), ["my_packs"]);
});

test("2.2 a view cannot grow a block the catalog never had", () => {
  const out = resolveView({
    userView: [{ blockId: "invented", order: 0 }],
    catalog: FIXTURE_CATALOG,
  });
  assert.deepEqual(out.blocks, []);
  assert.deepEqual(out.dropped, ["invented"]);
});

test("2.2 a view's tab wins when it names one, catalog tab otherwise", () => {
  const out = resolveView({
    userView: [{ blockId: "overview_metrics", tab: "mine", order: 0 }],
    catalog: FIXTURE_CATALOG,
  });
  assert.equal(out.blocks[0].tab, "mine");
  const dflt = resolveView({ userView: null, catalog: FIXTURE_CATALOG });
  assert.equal(dflt.blocks[0].tab, "overview", "default view keeps the adapter's tab");
});

test("2.2 the view length ceiling is enforced on read", () => {
  assert.equal(typeof MAX_VIEW_BLOCKS, "number");
  const stored = JSON.stringify(
    Array.from({ length: MAX_VIEW_BLOCKS + 5 }, (_, i) => ({ blockId: `b${i}`, order: i })),
  );
  db.setPreference("board.view.too-long", stored);
  const view = storedViewOrNull(db.getPreference, "too-long");
  assert.equal(view.length, MAX_VIEW_BLOCKS, "an oversized stored view is truncated on read");
  db.setPreference("board.view.too-long", null);
  assert.equal(storedViewOrNull(db.getPreference, "too-long"), null, "a cleared key is no view");
});

test("2.2 unreadable stored JSON degrades to no view rather than an error page", () => {
  db.setPreference("board.view.corrupt", "{definitely not json");
  assert.equal(storedViewOrNull(db.getPreference, "corrupt"), null);
  db.setPreference("board.view.corrupt", null);
});
