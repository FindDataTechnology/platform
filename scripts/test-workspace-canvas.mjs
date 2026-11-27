#!/usr/bin/env node
// ── workspace canvas projection tests (add-agent-builder-workspace 6.1-6.3) ──
//
// Source-contract + pure-function coverage for the document↔canvas seam:
//   1. projection: template members → unborn canvas posts (never live), target
//      kinds map through the SAME table the provisioner uses, agent names fill
//      bare titles, edges carry verbatim
//   2. empty fleet → null (the graph card falls back to the empty hint)
//   3. draft merge: kept-minus-removals + additions, fanout keys, idempotent
//      confirm (double merge doesn't duplicate), exit-discard touches nothing
//   4. 6.3 positions: the storage key is doc:<id> — same contract as fleet:<id>
//      (source assertion on the page) and positions never enter PUT bodies
//
//   node --test scripts/test-workspace-canvas.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

// .mjs cannot import .ts at runtime — exercise the pure functions by reading
// the module with a tiny TS-strip? No: the repo convention keeps behavior legs
// in e2e and pins structure here. The two pure functions are simple enough to
// re-execute via a regex-free transpile: strip types with node's built-in
// (Node 23+ type stripping) — the repo ships Node 25, so import() just works.
const { projectFleetDocCanvas, applyDraftEdgesToFleet, edgeKeyOf } = await import("../web/src/lib/workspace-canvas.ts");

const TEAM = {
  kind: "team",
  boundary: { name: "T", oneLine: "x", outOfScope: "" },
  agents: [
    { id: "agent-1", name: "速读员", persona: "p" },
    { id: "agent-2", name: "报班岗", persona: "q" },
  ],
  fleet: {
    name: "T",
    members: [
      { ref: "watch", title: "盯梢岗", target: { kind: "tool", id: "websearch::web_search" } },
      { ref: "brief", title: "", target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "agent-1" } },
      { ref: "hub", title: "汇总岗", target: { kind: "existing-persona", id: "agent-2" } },
    ],
    orchestration: {
      pattern: "pipeline",
      edges: [
        { kind: "handoff", from: "watch", to: "brief" },
        { kind: "handoff", from: "brief", to: "hub" },
      ],
    },
  },
  mcpServers: [],
  skills: [],
};

test("projection: unborn posts, provisioner's kind table, agent names fill bare titles", () => {
  const proj = projectFleetDocCanvas(TEAM);
  assert.ok(proj, "a fleet with members projects");
  assert.equal(proj.members.length, 3);
  for (const m of proj.members) {
    assert.equal(m.status, "paused", `${m.id}: document posts are never live`);
    assert.equal(m.slots.length, 0, "no evidence exists in a document");
    assert.equal(m.lastRunAt, null);
  }
  assert.equal(proj.members.find((m) => m.id === "watch").kind, "tool");
  assert.equal(proj.members.find((m) => m.id === "brief").kind, "persona", "pack-preset → persona");
  assert.equal(proj.members.find((m) => m.id === "brief").title, "速读员", "bare title falls back to the agent's name");
  assert.equal(proj.members.find((m) => m.id === "hub").title, "汇总岗", "declared title wins over the agent name");
  assert.equal(proj.edges.length, 2, "declared edges carry verbatim");
});

test("projection: members-less fleet → null (empty hint path)", () => {
  assert.equal(projectFleetDocCanvas({ ...TEAM, fleet: { name: "T", members: [] } }), null);
  assert.equal(projectFleetDocCanvas({ kind: "team", agents: [] }), null);
});

test("draft merge: kept-minus-removals + additions; fanout keys; double-merge idempotent", () => {
  const added = [{ kind: "handoff", from: "hub", to: "watch" }];
  const merged = applyDraftEdgesToFleet(TEAM.fleet, added, ["watch→brief:handoff"]);
  const edges = merged.orchestration.edges;
  assert.equal(edges.length, 2, "2 declared - 1 removed + 1 added");
  assert.ok(!edges.some((e) => e.from === "watch" && e.to === "brief"));
  assert.ok(edges.some((e) => e.from === "hub" && e.to === "watch"));
  // Idempotent: applying the same draft to the ALREADY-merged fleet adds nothing.
  const again = applyDraftEdgesToFleet(merged, added, []);
  assert.equal(again.orchestration.edges.length, 2, "no duplicate edges on repeat confirm");
  // Discard equivalence: zero ops return a byte-equal orchestration.
  const untouched = applyDraftEdgesToFleet(TEAM.fleet, [], []);
  assert.deepEqual(untouched.orchestration.edges, TEAM.fleet.orchestration.edges);
  // Fanout key shape.
  assert.equal(edgeKeyOf({ kind: "fanout", from: "a", targets: ["b", "c"] }), "a→b,c:fanout");
  assert.equal(edgeKeyOf({ kind: "handoff", from: "a", to: "b" }), "a→b:handoff");
});

test("6.3: positions live under doc:<id> via the shared canvas key and never enter PUT bodies", () => {
  const page = read("web/src/pages/AgentStudioPage.tsx");
  assert.match(page, /fleetId=\{`doc:\$\{doc\.id\}`\}/, "the canvas key is doc:<id> (same contract as fleet:<id>)");
  const canvas = read("web/src/components/fleet/FleetCanvas.tsx");
  assert.match(canvas, /storageKey = `platform\.fleetCanvas\.\$\{fleetId\}`/, "positions ride the canvas-local archive");
  // The merge writes ONLY orchestration.edges — positions are browser-local and
  // can never leak into the PUT body (declaration data stays pure).
  const lib = read("web/src/lib/workspace-canvas.ts");
  assert.ok(!/localStorage|position|override/i.test(lib), "the projection/merge layer never touches positions");
});
