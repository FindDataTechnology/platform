// Report edges derived from the org tree (fix-report-edge).
//
// `kind: "report"` used to be dead syntax: in the edge enum, labelled in six
// locales, rendered by the cockpit — and read by nothing. The topology it
// claimed to describe is already carried once, by `member.parentId`, which is
// what the report lane and the patrol context actually walk.
//
// So the edge is now a PROJECTION of the tree: always present, always true,
// never stored. A declaration that agrees is accepted (and not duplicated); one
// that contradicts the tree is refused, because a graph edge that lies is worse
// than no edge.
//
// Run: node --test scripts/test-report-edge-derived.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { expandedEdges, validateOrchestration } = await import("../server/fleet-orchestration.js");

const members = () => [
  { id: "ceo", parentId: null, title: "CEO", targetKind: "persona", targetId: "p-ceo" },
  { id: "shop", parentId: "ceo", title: "电商部", targetKind: "persona", targetId: "p-shop" },
  { id: "content", parentId: "shop", title: "内容组", targetKind: "persona", targetId: "p-content" },
  { id: "loner", parentId: null, title: "独立岗", targetKind: "persona", targetId: "p-loner" },
];

test("derived: one report edge per parent→child pair, read-time only", () => {
  const edges = expandedEdges({ members: members(), orchestration: {} });
  const reports = edges.filter((e) => e.kind === "report");
  // `from` reports upward to `to`: shop→ceo, content→shop.
  assert.deepEqual(
    reports.map((e) => `${e.from}->${e.to}`).sort(),
    ["content->shop", "shop->ceo"],
    "exactly the tree's two parent-child pairs",
  );
  assert.ok(reports.every((e) => e.derived === true), "marked derived, so a reader knows it is a projection");
  // Roots have no report edge — there is nobody above them.
  assert.equal(reports.some((e) => e.from === "loner" || e.to === "loner"), false);
});

test("derived: a truthful declaration is accepted and NOT duplicated", () => {
  const orch = { edges: [{ kind: "report", from: "shop", to: "ceo" }] };
  const v = validateOrchestration({ members: members(), orchestration: orch });
  assert.equal(v.ok, true, "stating the truth is allowed");
  const reports = expandedEdges({ members: members(), orchestration: orch }).filter((e) => e.kind === "report");
  assert.equal(reports.length, 2, "still two edges — the declared one is not counted twice");
  assert.equal(reports.find((e) => e.from === "shop").derived, undefined, "the declared one stays as declared");
});

test("derived: a contradicting declaration is refused, with the truth named", () => {
  const orch = { edges: [{ kind: "report", from: "shop", to: "loner" }] };
  const v = validateOrchestration({ members: members(), orchestration: orch });
  assert.equal(v.ok, false, "a lying edge must not save");
  const msg = v.errors.map((e) => e.error).join(" ");
  assert.match(msg, /must follow the org tree/);
  assert.match(msg, /'shop' reports to 'ceo', not 'loner'/, "the error states the real tree position");
});

test("derived: declared report edges do not grant dispatch", () => {
  // Guard against a future reader treating "report" as a permission edge —
  // dispatch grants come only from dispatch edges / supervisor / handoff pairs.
  const orch = { edges: [{ kind: "report", from: "shop", to: "ceo" }] };
  const v = validateOrchestration({ members: members(), orchestration: orch });
  assert.equal(v.ok, true);
  assert.equal(v.edges.filter((e) => e.kind === "dispatch").length, 0);
});

test("derived: no orchestration at all still shows the tree", () => {
  const edges = expandedEdges({ members: members(), orchestration: null });
  assert.equal(edges.filter((e) => e.kind === "report").length, 2, "a fleet without an orchestration section still has a report topology");
});
