// Unit tests for the resources list filter + facet counts
// (openspec: add-resource-filters, tasks 1.1 / 1.2).
//
// Covers:
//   - the extension→group map: each group's extensions, and both case and
//     suffix traps (report.XLSX must not land in spreadsheet via `%.xls`)
//   - every row belongs to exactly one group; unmatched extensions and rows
//     with no file are `other`, never dropped
//   - groups × since/until × q × type combine as AND
//   - an unrecognized group name narrows less instead of erroring
//   - facets are zero-filled for every group and computed WITHOUT the group
//     selection, so an unchecked chip still shows what is behind it
//
//   node --test scripts/test-resource-filters.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resource-filters-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const db = await import("../db.js");
await db.initDb();

// A stable clock: the fixtures are laid out on known ISO instants so the time
// window assertions are exact rather than relative to the run.
const DAY = 86_400_000;
const base = Date.parse("2026-10-16T12:00:00.000Z");
const at = (offsetDays, hour = 0) =>
  new Date(base - offsetDays * DAY + hour * 3600_000).toISOString();

function insert(id, { type = "file", title = id, filePath = null, createdAt } = {}) {
  return db.insertResource({
    id,
    type,
    title,
    source: "manual",
    filePath,
    contentHash: `hash-${id}`,
    createdAt,
    updatedAt: createdAt,
  });
}

// One fixture per group, plus the traps: an uppercase extension, an .xlsx that
// must not be caught by `%.xls`, and two rows that fall through to `other`.
const FIXTURES = [
  ["chart", { type: "chart", title: "营收图表", createdAt: at(0) }],
  ["doc", { title: "报告.pdf", filePath: "u/报告.pdf", createdAt: at(0) }],
  ["sheet", { title: "数据.csv", filePath: "u/数据.csv", createdAt: at(1) }],
  ["sheetx", { title: "明细.xlsx", filePath: "u/明细.xlsx", createdAt: at(1) }],
  ["pic", { title: "图.PNG", filePath: "u/图.PNG", createdAt: at(3) }],
  ["svg", { title: "矢量.svg", filePath: "u/矢量.svg", createdAt: at(3) }],
  ["slides", { title: "汇报.pptx", filePath: "u/汇报.pptx", createdAt: at(5) }],
  ["zip", { title: "归档.zip", filePath: "u/归档.zip", createdAt: at(5) }],
  ["page", { title: "页面.html", filePath: "u/页面.html", createdAt: at(8) }],
  ["json", { title: "配置.json", filePath: "u/配置.json", createdAt: at(8) }],
  ["unknown", { title: "未知.qqq", filePath: "u/未知.qqq", createdAt: at(10) }],
  ["nofile", { title: "无文件", createdAt: at(40) }],
  ["old-doc", { title: "旧报告.pdf", filePath: "u/旧报告.pdf", createdAt: at(40) }],
];

for (const [id, fields] of FIXTURES) insert(id, fields);

const ids = (page) => page.items.map((r) => r.id).sort();

test("every row lands in exactly one group; unmatched are `other`", () => {
  const all = Object.fromEntries(
    db.RESOURCE_GROUPS.map((g) => [g, ids(db.listResources({ groups: [g], limit: 200 }))])
  );
  assert.deepEqual(all.chart, ["chart"]);
  assert.deepEqual(all.document, ["doc", "old-doc"]);
  // The suffix trap: `%.xls` must not swallow `明细.xlsx`.
  assert.deepEqual(all.spreadsheet.sort(), ["sheet", "sheetx"]);
  assert.deepEqual(all.image.sort(), ["pic", "svg"], "uppercase .PNG and .svg are both images");
  assert.deepEqual(all.slideshow, ["slides"]);
  assert.deepEqual(all.archive, ["zip"]);
  assert.deepEqual(all.web, ["page"]);
  assert.deepEqual(all.data, ["json"]);
  assert.deepEqual(all.other.sort(), ["nofile", "unknown"], "unmatched and fileless rows are other");

  const covered = Object.values(all).flat().sort();
  const everything = ids(db.listResources({ limit: 200 }));
  assert.deepEqual(covered, everything, "the groups partition the library — no row is lost");
});

test("groups are OR-ed within the filter and AND-ed with the rest", () => {
  const docOrJson = ids(db.listResources({ groups: ["document", "data"], limit: 200 }));
  assert.deepEqual(docOrJson.sort(), ["doc", "json", "old-doc"]);

  // AND with the title search and with the row type.
  assert.deepEqual(ids(db.listResources({ groups: ["document"], q: "旧", limit: 200 })), ["old-doc"]);
  assert.deepEqual(
    ids(db.listResources({ groups: ["document"], type: "chart", limit: 200 })),
    [],
    "a chart row never matches a file group"
  );
});

test("since/until window on created_at, inclusive at both ends", () => {
  const last7 = db.listResources({ since: at(7), limit: 200 });
  assert.ok(last7.items.some((r) => r.id === "zip"), "5 days ago is inside a 7-day window");
  assert.ok(!last7.items.some((r) => r.id === "page"), "8 days ago is outside a 7-day window");
  assert.ok(!last7.items.some((r) => r.id === "unknown"), "10 days ago is outside a 7-day window");
  assert.ok(!last7.items.some((r) => r.id === "old-doc"), "40 days ago is outside a 7-day window");
  assert.equal(last7.facets.document, 1, "of two PDFs only the recent one counts");

  // `at(n)` is n days ago, so a window runs from the older bound to the newer.
  const middle = ids(db.listResources({ since: at(6), until: at(4), limit: 200 }));
  assert.deepEqual(middle.sort(), ["slides", "zip"]);

  // Inclusive boundaries: a row exactly at either bound is inside.
  assert.deepEqual(ids(db.listResources({ since: at(5), until: at(5), limit: 200 })).sort(), ["slides", "zip"]);
});

test("an unknown group name narrows less rather than erroring", () => {
  const withJunk = db.listResources({ groups: ["document", "not-a-group"], limit: 200 });
  assert.deepEqual(ids(withJunk), ["doc", "old-doc"], "the junk name is dropped, not fatal");
  const onlyJunk = db.listResources({ groups: ["not-a-group"], limit: 200 });
  assert.equal(onlyJunk.total, db.listResources({ limit: 200 }).total, "all junk = no group filter");
});

test("facets count the window and the search, never the group selection", () => {
  const page = db.listResources({ groups: ["document"], limit: 200 });
  assert.equal(page.facets.document, 2);
  assert.equal(page.facets.chart, 1, "an unchecked group still reports its count");
  assert.equal(page.facets.other, 2);

  // The window narrows the counts...
  const recent = db.listResources({ since: at(7), groups: ["document"], limit: 200 });
  assert.equal(recent.facets.document, 1, "旧报告.pdf is 40 days old");
  assert.equal(recent.facets.chart, 1);
  // ...and so does the title search.
  const searched = db.listResources({ q: "旧", limit: 200 });
  assert.equal(searched.facets.document, 1);
  assert.equal(searched.facets.chart, 0);
});

test("facets are zero-filled for every group even when empty", () => {
  const empty = db.listResources({ q: "不存在的东西", limit: 10 });
  assert.deepEqual(Object.keys(empty.facets).sort(), [...db.RESOURCE_GROUPS].sort());
  assert.deepEqual(Object.values(empty.facets), db.RESOURCE_GROUPS.map(() => 0));
});

test("an empty library lists nothing and still returns facets", () => {
  const handle = db.getDb();
  handle.prepare("DELETE FROM resources").run();
  const page = db.listResources({ limit: 10 });
  assert.equal(page.items.length, 0);
  assert.equal(page.total, 0);
  assert.equal(page.facets.chart, 0);
});
