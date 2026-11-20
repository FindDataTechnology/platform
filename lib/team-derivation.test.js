// Tests for lib/team-derivation.js (openspec: team-derivation).
// Run: node --test lib/team-derivation.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { deriveTeam, ROSTER_STATE, ROSTER_ORDER } from "./team-derivation.js";

const crew = (over = {}) => ({
  name: "T",
  fleet: {
    name: "T",
    members: [
      {
        ref: "watcher",
        title: "Inspector",
        parentRef: "chief",
        target: { kind: "pack-preset", presetId: "w-1", packId: "PACK_A" },
        cadence: { cron: "7 9 * * *", tz: "Asia/Shanghai" },
        kpiSlots: [{ key: "scanned", label: "Scanned", unit: "rows" }],
      },
      {
        ref: "chief",
        title: "Chief",
        parentRef: null,
        target: { kind: "pack-preset", presetId: "c-1", packId: "PACK_A" },
        cadence: { cron: "37 9 * * *", tz: "Asia/Shanghai" },
        kpiSlots: [{ key: "brief_digest", label: "Brief" }],
      },
    ],
    orchestration: {
      mode: "schedule",
      edges: [
        { kind: "trigger", from: "cron(7 9 * * *)", to: "watcher" },
        { kind: "handoff", from: "watcher", to: "chief" },
      ],
    },
    ...over.fleet,
  },
  acceptance: [
    { id: "a1", kind: "post-materialized", target: "Inspector" },
    { id: "a2", kind: "llm-judged", target: "Chief", rubric: "not projected" },
  ],
  ...over,
});

test("a pack with no fleet block is UNDECLARED, not an empty roster", () => {
  const r = deriveTeam({ name: "single-skill", skills: [{ name: "x" }] });
  assert.equal(r.state, ROSTER_STATE.UNDECLARED);
  assert.equal(r.roster, undefined);
});

test("a declared roster derives rows in manifest order", () => {
  const r = deriveTeam(crew());
  assert.equal(r.state, ROSTER_STATE.PRESENT);
  assert.deepEqual(r.roster.map((x) => x.ref), ["watcher", "chief"]);
  assert.equal(r.roster[0].title, "Inspector");
  assert.equal(r.roster[0].parentRef, "chief");
  assert.equal(r.roster[1].parentRef, null);
});

test("cadence is reported with declared:false when absent, never invented", () => {
  const c = crew();
  delete c.fleet.members[1].cadence;
  const chief = deriveTeam(c).roster.find((x) => x.ref === "chief");
  assert.deepEqual(chief.cadence, { declared: false });
});

test("kpiSlots keep key/label/unit and mark explicit empty as declared", () => {
  const c = crew();
  c.fleet.members[1].kpiSlots = [];
  const r = deriveTeam(c);
  assert.equal(r.roster[1].kpiSlotsDeclared, true);
  assert.deepEqual(r.roster[1].kpiSlots, []);
  assert.equal(r.roster[0].kpiSlots[0].unit, "rows");
});

test("a missing kpiSlots key is an error (无量可报要显式登记空集)", () => {
  const c = crew();
  delete c.fleet.members[0].kpiSlots;
  const r = deriveTeam(c);
  assert.equal(r.state, ROSTER_STATE.INVALID);
  assert.ok(r.errors.some((e) => e.includes("kpiSlots")));
});

test("each row points at its pillar projection instead of copying it", () => {
  const r = deriveTeam(crew());
  assert.deepEqual(r.roster[0].pillarsRef, { agentId: "w-1", packId: "PACK_A" });
});

test("deriveTeam returns NO pillar value fields — the boundary is testable", () => {
  // The whole point of keeping this separate from derivePillars: a later
  // implementer must not fold memory/toolkit into the roster. If this fails,
  // teams and pillars have become two sources for the same values.
  const flat = JSON.stringify(deriveTeam(crew()));
  for (const banned of ['"toolkit"', '"memory"', '"dashboard"', '"effective"']) {
    assert.ok(!flat.includes(banned), `roster must not carry ${banned}`);
  }
});

test("edges are returned verbatim, not re-derived from parentRef", () => {
  const r = deriveTeam(crew());
  assert.deepEqual(r.edges, [
    { kind: "trigger", from: "cron(7 9 * * *)", to: "watcher" },
    { kind: "handoff", from: "watcher", to: "chief" },
  ]);
});

test("acceptance carries kind and target but never the rubric prose", () => {
  const r = deriveTeam(crew());
  assert.deepEqual(r.acceptance.map((a) => a.kind), ["post-materialized", "llm-judged"]);
  assert.ok(!JSON.stringify(r.acceptance).includes("not projected"));
});

test("determinism: two derivations are field-by-field identical", () => {
  const a = deriveTeam(crew());
  const b = deriveTeam(crew());
  assert.deepEqual(a, b);
});

test("member scope is a projection of the whole result", () => {
  const all = deriveTeam(crew());
  const one = deriveTeam(crew(), { memberRef: "watcher" });
  assert.equal(one.state, ROSTER_STATE.PRESENT);
  assert.equal(one.roster.length, 1);
  assert.deepEqual(one.roster[0], all.roster[0]);
  // edges/acceptance describe the whole team, so a scoped answer cannot carry them
  assert.deepEqual(one.edges, []);
  assert.deepEqual(one.acceptance, []);
});

test("a memberRef the pack does not carry is INVALID, not a silent fallback", () => {
  const r = deriveTeam(crew(), { memberRef: "nobody" });
  assert.equal(r.state, ROSTER_STATE.INVALID);
  assert.ok(r.errors[0].includes("nobody"));
});

test("instantiated:false reports NOT_INSTANTIATED; null makes no claim", () => {
  assert.equal(deriveTeam(crew(), { instantiated: false }).state, ROSTER_STATE.NOT_INSTANTIATED);
  assert.equal(deriveTeam(crew(), { instantiated: null }).state, ROSTER_STATE.PRESENT);
  assert.equal(deriveTeam(crew(), { instantiated: true }).state, ROSTER_STATE.PRESENT);
});

test("an empty members array is INVALID", () => {
  const r = deriveTeam({ fleet: { members: [] } });
  assert.equal(r.state, ROSTER_STATE.INVALID);
});

test("a member without a target is named in the errors", () => {
  const c = crew();
  delete c.fleet.members[0].target;
  const r = deriveTeam(c);
  assert.equal(r.state, ROSTER_STATE.INVALID);
  assert.ok(r.errors.some((e) => e.includes("watcher") && e.includes("target")));
});

test("ROSTER_ORDER is the fixed render order", () => {
  assert.deepEqual([...ROSTER_ORDER], ["roster", "edges", "acceptance"]);
});
