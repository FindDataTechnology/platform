// Deeper-than-direct-children report visibility (fix-fleet-descendant-reports).
//
// The fleet hierarchy IS the report channel: a patrol's context carried its
// DIRECT children only, so anything below them reached the post solely if every
// intermediate post relayed it. There was no read path either — no fleet tool
// lists other members' reports. All shipped templates are two levels, so this
// changes nothing for them (that is asserted here); a user-built deeper fleet
// now sees the bottom layer as compact blocks.
//
// Run: node --test scripts/test-fleet-descendant-reports.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-descendant-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;

const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
const { buildFleetContext, collectDeeperDescendants } = await import("../server/fleet-context.js");

const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
const fleet = fleetDb.createFleet({ id: "f_deep", name: "三层舰", ownerEmail: "owner@test" });

const mk = (id, title, parentId, kpiSlots = []) =>
  fleetDb.createMember({ id, fleetId: fleet.id, title, targetKind: "persona", targetId: `p-${id}`, parentId, kpiSlots, cadence: null });

mk("ceo", "总编", null, [{ key: "pieces", label: "产出", unit: "篇" }]);
mk("editor", "主编", "ceo", [{ key: "pieces", label: "产出", unit: "篇" }]);
mk("writer", "撰稿", "editor", [{ key: "words", label: "字数", unit: "字" }]);
mk("intern", "实习", "writer"); // 第 4 层，无报数

const report = (memberId, { metrics = {}, summary, blockers = [] } = {}) =>
  fleetDb.appendReport({
    id: `r_${memberId}_${Math.random().toString(36).slice(2, 7)}`,
    fleetId: fleet.id,
    memberId,
    metrics,
    summary: summary ?? `${memberId} 报数`,
    blockers,
    resources: [],
    source: "self",
    createdAt: Date.now(),
  });

report("ceo", { metrics: { pieces: { value: 3 } }, summary: "总编：本周三篇" });
report("editor", { metrics: { pieces: { value: 2 } }, summary: "主编：两篇在改" });
report("writer", { metrics: { words: { value: 4200 } }, summary: "撰稿：初稿已交", blockers: ["缺素材授权"] });

const deps = {
  db: fleetDb,
  deriveStatuses: () => new Map([["ceo", "on_duty"], ["editor", "on_duty"], ["writer", "on_duty"]]),
};

test("collectDeeperDescendants: breadth-first from level 2, cycle safe", () => {
  const members = fleetDb.listMembers(fleet.id);
  const deep = collectDeeperDescendants(members, "ceo");
  assert.deepEqual(deep.map((d) => [d.member.id, d.depth]), [["writer", 2], ["intern", 3]]);
  // From the middle post, the writer is a DIRECT child — only its child is "deeper".
  const fromEditor = collectDeeperDescendants(members, "editor");
  assert.deepEqual(fromEditor.map((d) => [d.member.id, d.depth]), [["intern", 2]]);
  // A malformed chain (a → b → a) must terminate and emit each post once.
  const looped = [
    { id: "x", title: "X", parentId: "x" },
    { id: "a", title: "A", parentId: "x" },
    { id: "b", title: "B", parentId: "a" },
  ];
  assert.deepEqual(collectDeeperDescendants(looped, "x").map((d) => [d.member.id, d.depth]), [["b", 2]]);
});

test("三条线：祖辈的巡视上下文看见孙辈的最新报数", async () => {
  const out = await buildFleetContext({ fleetId: fleet.id, memberId: "ceo" }, {}, deps);
  assert.match(out, /### 主编/, "direct child still renders as a full block");
  assert.match(out, /【更深层报数（直接下级的下级及以下）】/);
  assert.match(out, /### 撰稿（第 2 层｜总编 > 主编）/, "the grandchild is named with its depth and path");
  assert.match(out, /字数（字）: 4200/, "its declared slot value rides along");
  assert.match(out, /缺素材授权/, "its blockers too — this is the point (the relay could drop them)");
  assert.match(out, /### 实习（第 3 层/, "level 3 is included");
  assert.match(out, /实习（第 3 层[\s\S]*?（尚无报数）/, "a deeper post without a report says so");
});

test("两层舰队零变化：不出现任何更深层段", async () => {
  const f2 = fleetDb.createFleet({ id: "f_two", name: "两层舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "boss", fleetId: f2.id, title: "老板", targetKind: "persona", targetId: "p-boss", parentId: null, kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "staff", fleetId: f2.id, title: "员工", targetKind: "persona", targetId: "p-staff", parentId: "boss", kpiSlots: [], cadence: null });
  fleetDb.appendReport({ id: "r_two_1", fleetId: f2.id, memberId: "staff", metrics: {}, summary: "在办两件", blockers: [], resources: [], source: "self", createdAt: Date.now() });
  const out = await buildFleetContext({ fleetId: f2.id, memberId: "boss" }, {}, { db: fleetDb, deriveStatuses: () => new Map() });
  assert.ok(!out.includes("更深层"), "no segment, no header, no truncation mark");
  assert.match(out, /### 员工/);
  assert.match(out, /在办两件/);
});

test("直接下级的预算不被更深层挤占（子池独立）", async () => {
  const f3 = fleetDb.createFleet({ id: "f_budget", name: "预算舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "top", fleetId: f3.id, title: "顶层", targetKind: "persona", targetId: "p-top", parentId: null, kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "mid", fleetId: f3.id, title: "中层", targetKind: "persona", targetId: "p-mid", parentId: "top", kpiSlots: [], cadence: null });
  // One direct child with a long report, plus 20 deep grandchildren.
  fleetDb.appendReport({
    id: "r_mid_big", fleetId: f3.id, memberId: "mid", metrics: {},
    summary: "中".repeat(3800), blockers: [], resources: [], source: "self", createdAt: Date.now(),
  });
  for (let i = 0; i < 20; i++) {
    fleetDb.createMember({ id: `g${i}`, fleetId: f3.id, title: `孙${i}`, targetKind: "persona", targetId: `p-g${i}`, parentId: "mid", kpiSlots: [], cadence: null });
    fleetDb.appendReport({ id: `r_g${i}`, fleetId: f3.id, memberId: `g${i}`, metrics: {}, summary: `孙${i} 报数`, blockers: [], resources: [], source: "self", createdAt: Date.now() });
  }
  const out = await buildFleetContext({ fleetId: f3.id, memberId: "top" }, {}, { db: fleetDb, deriveStatuses: () => new Map() });
  assert.match(out, /### 中层/, "the direct child is never dropped for the deep tree");
  assert.match(out, /孙0 报数/, "the deep layer still gets its capped share");
  assert.match(out, /另有 \d+ 个更深层岗位因条数或总量上限未注入/, "the cut is stated, not silent");
  const shown = [...out.matchAll(/### (孙\d+)（/g)].map((m) => m[1]).length;
  assert.ok(shown <= 8, `at most DEEP_MAX_POSTS deep blocks (saw ${shown})`);
});
