// Unit tests — console view model (change add-pack-console, task 2.2/3.1/3.2).
// Run: node --test scripts/test-pack-console-view-model.mjs
//
// Pins the three properties the spec makes load-bearing:
//   1. the surface cut happens in the RESPONSE (an undeclared block's title and
//      data must be absent, not merely hidden by a client);
//   2. absence is reported, never fabricated (no rows, no zero, no estimate);
//   3. the share surface carries no model / roster / tool-face information.
//
// The member view is injected here exactly as the route injects it, so these
// tests exercise the block builders without standing up the fleet route.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pack-console-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
const { buildConsoleViewModel, SHARE_STRIPPED_MEMBER_FIELDS } = await import("../server/console-blocks/index.js");

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let db;
beforeEach(() => {
  db = createFleetDatabase({
    file: path.join(tmpRoot, `console-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
});

function fleet(over = {}) {
  return db.createFleet({
    id: "fleet_console",
    name: "电商团队",
    ownerEmail: "owner@test",
    state: "active",
    ...over,
  });
}

function member(fleetId, over = {}) {
  return db.createMember({
    id: over.id ?? `m_${Math.random().toString(36).slice(2, 8)}`,
    fleetId,
    title: over.title ?? "投放组",
    parentId: over.parentId ?? null,
    targetKind: "persona",
    targetId: over.targetId ?? "persona-a",
    kpiSlots: over.kpiSlots ?? [],
    cadence: over.cadence === undefined ? null : over.cadence,
  });
}

// The route's injection seam: a stand-in for `memberView`, shaped like it.
function fakeMemberView(statusById = {}, { latestReport = null } = {}) {
  return (_db, _fleet, m) => ({
    id: m.id,
    fleetId: m.fleetId,
    title: m.title,
    parentId: m.parentId,
    target: { kind: m.targetKind, id: m.targetId, label: m.targetId, servingPath: null },
    kpiSlots: m.kpiSlots,
    cadence: m.cadence,
    model: "deepseek-v4-pro",
    fallbackModel: null,
    effectiveModel: "deepseek-v4-pro",
    modelNotice: null,
    effort: "high",
    contextBudget: 128000,
    carrier: "auto",
    inputPolicy: null,
    effectiveInputPolicy: null,
    taskId: "job_1",
    status: statusById[m.id] ?? "on_duty",
    statusReason: null,
    missedRounds: 0,
    skippedRounds: 0,
    failureStreak: 0,
    failingSince: null,
    lastErrorKind: null,
    lastTurn: { status: "ok", errorKind: null, error: null },
    consecutiveFailures: 0,
    latestReport,
  });
}

const SECTION = {
  headline: "team.statusCounts",
  blocks: [
    { block: "team", surfaces: ["platform", "share"] },
    { block: "stream", surfaces: ["platform", "share"] },
    { block: "kpi", surfaces: ["platform", "share"] },
    { block: "decisions", surfaces: ["platform"] },
    { block: "spend", surfaces: ["platform"] },
    { block: "orchestration", surfaces: ["platform"] },
  ],
};

test("platform surface assembles every declared block", () => {
  const f = fleet();
  member(f.id, { id: "m1", title: "投放组" });
  const view = buildConsoleViewModel({
    section: SECTION,
    surface: "platform",
    db,
    fleet: f,
    memberView: fakeMemberView(),
  });
  assert.equal(view.v, 1);
  assert.equal(view.surface, "platform");
  assert.deepEqual(
    view.blocks.map((b) => b.block),
    ["team", "stream", "kpi", "decisions", "spend", "orchestration"],
  );
});

test("the share cut removes blocks from the response, not just from the UI", () => {
  const f = fleet();
  member(f.id, { id: "m1" });
  const view = buildConsoleViewModel({
    section: SECTION,
    surface: "share",
    db,
    fleet: f,
    memberView: fakeMemberView(),
  });
  const ids = view.blocks.map((b) => b.block);
  assert.deepEqual(ids, ["team", "stream", "kpi"]);
  // The blocked-out blocks must not appear even as empty shells.
  for (const missing of ["decisions", "spend", "orchestration"]) {
    assert.equal(ids.includes(missing), false, `${missing} leaked into the share response`);
  }
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("decisions"), false);
  assert.equal(serialized.includes("spend"), false);
});

test("the share surface carries no model, roster or tool-face fields", () => {
  const f = fleet();
  member(f.id, { id: "m1" });
  const view = buildConsoleViewModel({
    section: SECTION,
    surface: "share",
    db,
    fleet: f,
    memberView: fakeMemberView(),
  });
  const team = view.blocks.find((b) => b.block === "team");
  assert.equal(team.state, "ready");
  for (const row of team.data.members) {
    for (const field of ["model", "effectiveModel", "effort", "contextBudget", "taskId", "lastTurn"]) {
      assert.equal(field in row, false, `share row leaked '${field}'`);
    }
    // What a published console DOES show survives the strip.
    assert.ok(row.title);
    assert.ok(row.status);
  }
  // The stripping list itself stays honest about what it covers.
  assert.ok(SHARE_STRIPPED_MEMBER_FIELDS.includes("effectiveModel"));
});

test("an empty roster reports absence instead of an empty success", () => {
  const f = fleet();
  const view = buildConsoleViewModel({ section: SECTION, db, fleet: f, memberView: fakeMemberView() });
  const team = view.blocks.find((b) => b.block === "team");
  assert.equal(team.state, "absent");
  assert.equal(team.absentReason, "no_members");
  assert.equal(team.data, undefined);
});

test("no reports means absent kpi and an absent stream, never zeros", () => {
  const f = fleet();
  member(f.id, { id: "m1" });
  const view = buildConsoleViewModel({ section: SECTION, db, fleet: f, memberView: fakeMemberView() });
  const kpi = view.blocks.find((b) => b.block === "kpi");
  const stream = view.blocks.find((b) => b.block === "stream");
  assert.equal(kpi.state, "absent");
  assert.equal(kpi.absentReason, "no_reported_kpis");
  assert.equal(stream.state, "absent");
  assert.equal(stream.absentReason, "no_reports");
});

test("a headline over an absent block resolves to null, not 0", () => {
  const f = fleet();
  const section = { headline: "kpi.total", blocks: [{ block: "kpi" }] };
  const view = buildConsoleViewModel({ section, db, fleet: f, memberView: fakeMemberView() });
  assert.equal(view.headline.value, null);
  assert.equal(view.headline.block, "kpi");
});

test("a headline over a ready block resolves the declared field", () => {
  const f = fleet();
  member(f.id, { id: "m1" });
  member(f.id, { id: "m2" });
  const section = { headline: "team.statusCounts", blocks: [{ block: "team" }] };
  const view = buildConsoleViewModel({ section, db, fleet: f, memberView: fakeMemberView() });
  assert.equal(view.headline.value.on_duty, 2);
});

test("open decisions order by severity then expiry", () => {
  const f = fleet();
  member(f.id, { id: "m1", title: "投放组" });
  db.appendDecision({ id: "d_low", fleetId: f.id, memberId: "m1", severity: "low", question: "低风险事项" });
  db.appendDecision({ id: "d_high", fleetId: f.id, memberId: "m1", severity: "high", question: "高风险事项" });
  const section = { blocks: [{ block: "decisions" }] };
  const view = buildConsoleViewModel({ section, db, fleet: f, memberView: fakeMemberView() });
  const block = view.blocks[0];
  assert.equal(block.state, "ready");
  assert.deepEqual(
    block.data.items.map((i) => i.id),
    ["d_high", "d_low"],
  );
  assert.equal(block.data.items[0].memberTitle, "投放组");
});

test("spend is absent until the fleet has recorded a run", () => {
  const f = fleet();
  member(f.id, { id: "m1" });
  const view = buildConsoleViewModel({ section: { blocks: [{ block: "spend" }] }, db, fleet: f, memberView: fakeMemberView() });
  assert.equal(view.blocks[0].state, "absent");
  assert.equal(view.blocks[0].absentReason, "no_run_records");
});

test("a declared orchestration expands into the derived report edges", () => {
  const f = fleet({ orchestration: { edges: [{ kind: "handoff", from: "m_parent", to: "m_child" }] } });
  member(f.id, { id: "m_parent" });
  member(f.id, { id: "m_child", parentId: "m_parent" });
  const view = buildConsoleViewModel({ section: { blocks: [{ block: "orchestration" }] }, db, fleet: f, memberView: fakeMemberView() });
  const block = view.blocks[0];
  assert.equal(block.state, "ready");
  const kinds = block.data.expanded.map((e) => e.kind);
  assert.ok(kinds.includes("handoff"));
  assert.ok(kinds.includes("report"), "the parent/child report edge is derived, not declared");
});

test("an undeclared orchestration is absent, not an empty edge list", () => {
  const f = fleet();
  member(f.id, { id: "m1" });
  const view = buildConsoleViewModel({ section: { blocks: [{ block: "orchestration" }] }, db, fleet: f, memberView: fakeMemberView() });
  assert.equal(view.blocks[0].state, "absent");
  assert.equal(view.blocks[0].absentReason, "not_declared");
});

test("an unknown block id degrades to a named absence instead of failing the page", () => {
  const f = fleet();
  member(f.id, { id: "m1" });
  const view = buildConsoleViewModel({
    section: { blocks: [{ block: "sales-funnel" }, { block: "team" }] },
    db,
    fleet: f,
    memberView: fakeMemberView(),
  });
  assert.deepEqual(view.blocks[0], { block: "sales-funnel", state: "absent", absentReason: "unknown_block" });
  assert.equal(view.blocks[1].state, "ready", "the rest of the page still renders");
});

test("a block's params reach its builder", () => {
  const f = fleet();
  member(f.id, { id: "m1" });
  for (let i = 0; i < 6; i++) {
    db.appendDecision({ id: `d${i}`, fleetId: f.id, memberId: "m1", severity: "normal", question: `第${i}件` });
  }
  const view = buildConsoleViewModel({
    section: { blocks: [{ block: "decisions", params: { limit: 2 } }] },
    db,
    fleet: f,
    memberView: fakeMemberView(),
  });
  assert.equal(view.blocks[0].data.items.length, 2);
  assert.equal(view.blocks[0].data.open, 6, "open counts every item, the list is the bounded view");
});
