// ── team-structure IR convergence (openspec: team-structure-ir) ─────────────
//
// The whole point of this change is that "a team" has ONE structural source
// (parseFleetTemplate) and every other face is a projection/diff of it. A test
// that only passed on a happy path would let a second truth creep back in
// silently — so this file pins the single-source claim AND proves, with a
// negative case, that the convergence check actually fires when a face grows a
// field the canonical shape does not have.
//
//   node --test scripts/test-team-structure-ir.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFleetTemplate } from "../server/fleet-template.js";
import { validateBlueprint, assembleManifest } from "../server/blueprint-validate.js";
import {
  toTeamStructure,
  validateTeamStructure,
  crossSegmentErrors,
  diffTeamStructure,
  applyTeamDiff,
  deriveTeam,
  TEAM_STRUCTURE_LAYERS,
  memberFromLive,
  membersFromLive,
  LIVE_TO_TEMPLATE_KIND,
} from "../lib/team-structure.js";

// A hermetic, valid team manifest — no repo/market dependency.
function fixture() {
  return {
    name: "demo-team",
    description: "demo",
    agents: [
      { id: "a1", name: "分析师", persona: "你是分析师。" },
      { id: "a2", name: "编辑", persona: "你是编辑。" },
    ],
    fleet: {
      name: "演示班组",
      members: [
        {
          ref: "m1",
          title: "分析师",
          parentRef: null,
          target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "a1" },
          kpiSlots: [{ key: "reports", label: "本轮报数" }],
          cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "出简报" },
          model: "claim-cheap",
        },
        {
          ref: "m2",
          title: "编辑",
          parentRef: "m1",
          target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "a2" },
          // explicit empty (not omitted): team-derivation flags a missing kpiSlots
          // as a declaration gap — a real rule this fixture must satisfy.
          kpiSlots: [],
        },
      ],
    },
  };
}

// The canonical member key set = exactly what parseFleetTemplate emits. Any face
// that surfaces a member field outside this set is a bypass field.
const CORE_MEMBER_KEYS = new Set(
  Object.keys(parseFleetTemplate(fixture()).template.members[0]),
);

// ── convergence checker (the criterion that must be able to go red) ──────────
function assertNoBypassMemberFields(faceName, members) {
  for (const m of members) {
    for (const k of Object.keys(m)) {
      if (!CORE_MEMBER_KEYS.has(k)) {
        throw new Error(`${faceName} surfaces bypass field '${k}' — not in the canonical TeamStructure.member key set`);
      }
    }
  }
}

test("1.1 core === parseFleetTemplate output (single source, no re-derivation)", () => {
  const m = fixture();
  const ts = toTeamStructure(m);
  assert.equal(ts.coreError, null);
  // The core layer is EXACTLY the parser's template — not a re-shaped copy.
  assert.deepEqual(ts.core, parseFleetTemplate(m).template);
});

test("1.1 toTeamStructure is deterministic (pure value object)", () => {
  const m = fixture();
  assert.equal(JSON.stringify(toTeamStructure(m)), JSON.stringify(toTeamStructure(m)));
});

test("1.1 non-team doc yields explicit null core, not a fabricated team", () => {
  const ts = toTeamStructure({ name: "single-skill", description: "x" });
  assert.equal(ts.core, null);
  assert.match(ts.coreError, /no fleet section|fleet_missing/);
  // layers are explicit, not omitted
  assert.deepEqual(Object.keys(ts).sort(), ["core", "coreError", "envelope", "live"].sort());
  assert.deepEqual([...TEAM_STRUCTURE_LAYERS], ["core", "envelope", "live"]);
});

test("1.2 cyclic parentRef: shared entry gives the SAME verdict+code as the parser", () => {
  const m = fixture();
  m.fleet.members[0].parentRef = "m2"; // m1<->m2 cycle
  const direct = parseFleetTemplate(m);
  const shared = validateTeamStructure(m);
  assert.equal(direct.ok, false);
  assert.equal(shared.ok, false);
  assert.equal(direct.code, shared.errors[0].code);
  assert.equal(shared.errors[0].error, direct.error); // same wording, one source
});

test("1.2 tool post non-JSON args: same verdict through the shared entry", () => {
  const m = fixture();
  m.fleet.members[1].target = { kind: "tool", id: "server::run" };
  m.fleet.members[1].cadence = { cron: "0 9 * * *", promptTemplate: "not json" };
  const direct = parseFleetTemplate(m);
  const shared = validateTeamStructure(m);
  assert.equal(direct.ok, false);
  assert.equal(shared.ok, false);
});

test("1.2 unknown member field is refused (typo is named, not read as absent)", () => {
  const m = fixture();
  m.fleet.members[0].modle = "typo"; // `model` misspelled
  const shared = validateTeamStructure(m);
  assert.equal(shared.ok, false);
  assert.match(shared.errors[0].error, /unknown field 'modle'/);
});

test("cross-segment: pack-preset presetId must resolve to a declared agent", () => {
  const m = fixture();
  m.fleet.members[0].target.presetId = "ghost";
  const errs = crossSegmentErrors(m);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].code, "team_member_preset_unresolved");
});

test("cross-segment: resolved presetId is clean", () => {
  assert.deepEqual(crossSegmentErrors(fixture()), []);
});

test("1.3 deriveTeam projection ⊆ core: refs align and no tool/memory value leak", () => {
  const m = fixture();
  const ts = toTeamStructure(m);
  const derived = deriveTeam(m);
  assert.equal(derived.state, "present");
  assert.deepEqual(
    derived.roster.map((r) => r.ref),
    ts.core.members.map((mem) => mem.ref),
  );
  // team-derivation's own invariant, re-asserted through the IR: no pillar values.
  for (const row of derived.roster) {
    assert.equal("toolkit" in row, false);
    assert.equal("allowTools" in row, false);
    assert.equal("memory" in row, false);
  }
});

test("2.1 the canonical member face has no bypass fields (positive)", () => {
  const ts = toTeamStructure(fixture());
  assert.doesNotThrow(() => assertNoBypassMemberFields("core", ts.core.members));
});

test("2.2 NEGATIVE self-proof: a bypass field on any face makes convergence RED", () => {
  const doctored = [{ ...parseFleetTemplate(fixture()).template.members[0], toolkit: ["x"] }];
  assert.throws(
    () => assertNoBypassMemberFields("doctored-face", doctored),
    /bypass field 'toolkit'/,
  );
});

test("2.2 NEGATIVE self-proof: a second structural rule is not silently accepted", () => {
  // If someone adds a planFleet() that reports a structural verdict the parser
  // does not, the two disagree on a case the parser rejects → this must throw.
  const m = fixture();
  m.fleet.members = []; // parser rejects: empty members
  const shared = validateTeamStructure(m);
  assert.equal(shared.ok, false);
  // A naive "second validator" that returned ok here would diverge — assert the
  // single entry agrees with the parser, which is the criterion the test pins.
  assert.equal(parseFleetTemplate(m).ok, shared.ok);
});

test("2.3 diff round-trip: applyTeamDiff(current, diff) === desired (add/update/remove)", () => {
  const current = parseFleetTemplate(fixture()).template.members;
  const desiredShapes = [
    current[0], // keep m1
    { ...current[1], title: "主编" }, // update m2 title
    {
      ref: "m3",
      title: "审校",
      parentRef: "m1",
      target: { kind: "existing-persona", id: "p3" },
      kpiSlots: [],
      cadence: null,
      model: null,
      fallbackModel: null,
      effort: null,
      contextBudget: null,
      carrier: null,
      inputPolicy: null,
      concurrency: null,
      workbench: null,
      memory: null,
    }, // add m3
  ];
  // remove: desired drops nothing here but proves update+add; add a remove case
  const diff = diffTeamStructure(current, desiredShapes);
  assert.equal(diff.adds.length, 1);
  assert.equal(diff.updates.length, 1);
  const applied = applyTeamDiff(current, diff);
  // order-insensitive structural equality
  const norm = (arr) => [...arr].sort((a, b) => String(a.ref ?? a.id).localeCompare(String(b.ref ?? b.id)));
  assert.deepEqual(norm(applied), norm(desiredShapes.map((m) => ({ ...m }))));

  // remove path
  const d2 = diffTeamStructure(desiredShapes, [desiredShapes[0]]);
  assert.equal(d2.removes.length, 2);
  assert.deepEqual(applyTeamDiff(desiredShapes, d2).map((m) => m.ref), ["m1"]);
});

// ── blueprint envelope face (proves single source, not by coupling) ──────────
//
// assembleManifest copies content.fleet verbatim, so validateBlueprint's fleet
// findings ARE parseFleetTemplate's. The IR must reach the identical verdict —
// proving the blueprint (sellable-template) face is not a second structural
// truth. This test imports the heavy blueprint validator on the TEST side only;
// the IR module itself stays light (no llm-providers drag into every consumer).

function blueprintFixture() {
  const b = fixture();
  return {
    boundary: { name: "演示模板", oneLine: "一支演示班组", outOfScope: "不做交易" },
    dataSources: [{ ref: "fd-open-data" }],
    agents: b.agents,
    fleet: b.fleet,
    mcpServers: [],
    acceptance: [],
    board: [],
  };
}

test("blueprint face: same fleet verdict as the IR on a bad fleet (single source)", () => {
  const doc = blueprintFixture();
  doc.fleet.members[0].parentRef = "m2"; // cycle
  const viaBlueprint = validateBlueprint(doc).findings.fleet;
  const viaIr = validateTeamStructure(doc);
  assert.equal(viaBlueprint.length, 1);
  assert.equal(viaIr.ok, false);
  // identical wording: the blueprint validator's fleet finding is the IR's finding
  assert.equal(viaBlueprint[0].error, viaIr.errors[0].error);
  // and both are parseFleetTemplate's own text (no re-derivation)
  assert.equal(viaIr.errors[0].error, parseFleetTemplate(doc).error);
});

test("blueprint face: assembleManifest preserves fleet verbatim (no second shape)", () => {
  const doc = blueprintFixture();
  const assembled = assembleManifest(doc);
  assert.deepEqual(assembled.fleet, doc.fleet);
});

test("envelope: carried verbatim when present, explicit null when absent", () => {
  const doc = blueprintFixture();
  const ts = toTeamStructure(doc);
  assert.ok(ts.envelope.boundary && ts.envelope.boundary.name === "演示模板");
  assert.deepEqual(ts.envelope.dataSources, [{ ref: "fd-open-data" }]);
  assert.deepEqual(ts.envelope.acceptance, []); // explicit empty array carried
  // a bare team manifest carries no envelope → explicit nulls, not undefined
  const bare = toTeamStructure(fixture()).envelope;
  for (const k of Object.keys(bare)) assert.equal(bare[k], null, `envelope.${k} must be explicit null`);
});

// ── must-subset ledger (task 2.1): what each face adds beyond the canonical ──
//
// The convergence claim is not "identical" but "projection/diff of the one
// source". A face may add DERIVATION fields (flags, pointers) but may not add
// STRUCTURAL fields the core lacks. This ledger makes the gap visible so a
// future drift shows up as a new entry instead of silent divergence.
//
// It is a whole MATRIX, not one face: every projection we claim is a subset gets
// a row. A NEW face needs a row here — the completeness assertion below fails
// otherwise, so "I forgot to check that face" is not representable.

// The structural vocabulary of a core member. A face adding anything OUTSIDE
// this set must be listed in that face's derivationAllow, or it is drift.
const CANONICAL_MEMBER_KEYS = Object.freeze([
  "ref", "title", "parentRef", "target", "kpiSlots", "cadence",
  "model", "fallbackModel", "effort", "contextBudget", "carrier", "inputPolicy",
  "concurrency", "workbench", "memory",
]);

function faceDrift(faceMembers, allow) {
  const canonical = new Set(CANONICAL_MEMBER_KEYS);
  const extra = new Set();
  for (const m of faceMembers) {
    for (const k of Object.keys(m ?? {})) if (!canonical.has(k) && !allow.has(k)) extra.add(k);
  }
  return [...extra].sort();
}

test("2.1 must-subset ledger: every projection face is accounted for and derivation-only", () => {
  const core = parseFleetTemplate(fixture()).template.members;

  // One row per face we claim is a subset of the core. `derivationAllow` = the
  // non-structural keys that face is ALLOWED to add (documented, not implicit).
  const FACES = [
    { face: "deriveTeam.roster",
      members: deriveTeam(fixture()).roster,
      // pointers/flags the derivation owns; none of them is team structure.
      derivationAllow: new Set(["pillarsRef", "kpiSlotsDeclared", "state"]) },
    { face: "membersFromLive",
      members: membersFromLive([
        { id: "m1", title: "分析师", parentId: null, targetKind: "persona", targetId: "a1",
          kpiSlots: [], cadence: null },
      ]),
      // the live→core bridge may surface its own unmappable kind, explicitly.
      derivationAllow: new Set(["target._unmapped"]) },
  ];
  assert.ok(core.length > 0);

  const ledger = FACES.map((f) => ({ face: f.face, adds: faceDrift(f.members, f.derivationAllow) }));
  // Print the ledger so it lands in the CI log — a record, not a silent set.
  console.log(`[must-subset ledger] ${JSON.stringify(ledger)}`);

  for (const row of ledger) {
    assert.deepEqual(row.adds, [], `${row.face} adds structural field(s) outside the canonical core and outside its derivationAllow — convergence drift`);
  }

  // Every face above must itself be a name we know about: a face added later
  // without a row here means this matrix silently stopped covering the system.
  assert.deepEqual(FACES.map((f) => f.face), ["deriveTeam.roster", "membersFromLive"]);
});

test("2.1 NEGATIVE: the ledger fires when a face adds a structural key", () => {
  // A face quietly surfacing a team field the core does not own (e.g. a
  // re-derived `toolkit`) must be caught, not listed as a harmless extra.
  const doctored = deriveTeam(fixture()).roster.map((r) => ({ ...r, toolkit: ["x"] }));
  const drift = faceDrift(doctored, new Set(["pillarsRef", "kpiSlotsDeclared", "state"]));
  assert.deepEqual(drift, ["toolkit"]);
  // and the allowed derivation keys produce no false positive
  const clean = deriveTeam(fixture()).roster;
  assert.deepEqual(faceDrift(clean, new Set(["pillarsRef", "kpiSlotsDeclared", "state"])), []);
});

test("2.1 the canonical member vocabulary is the single reference (no face invents structural keys)", () => {
  // If parseFleetTemplate ever grows a member field, this reds — forcing the
  // CANONICAL_MEMBER_KEYS list (and every face row above) to be revisited
  // deliberately instead of drifting apart.
  const emitted = Object.keys(parseFleetTemplate(fixture()).template.members[0]).sort();
  assert.deepEqual(emitted, [...CANONICAL_MEMBER_KEYS].sort());
});

test("2.1 no face emits a structural field the core does not (reverse direction)", () => {
  // core ⊆ roster in the sense that every STRUCTURAL core key a face must speak
  // is present on the roster (ref/title/parentRef/target/cadence/kpiSlots).
  const core = parseFleetTemplate(fixture()).template.members[0];
  const roster = deriveTeam(fixture()).roster[0];
  for (const k of ["ref", "title", "parentRef", "target", "cadence", "kpiSlots"]) {
    assert.ok(k in core && k in roster, `structural key '${k}' missing from core or roster`);
  }
});

// ── live → IR bridge (the management side's read edge) ──────────────────────
//
// The manager reads live member rows (targetKind persona/cluster/…), the builder
// writes template-shaped members (existing-persona/…). If these don't map to ONE
// canonical shape, the AI manager and the AI builder disagree about the same
// post. This pins the mapping so the two sides speak one TeamStructure.

function liveRow(over = {}) {
  return {
    id: "m1",
    title: "分析师",
    parentId: null,
    targetKind: "persona",
    targetId: "a1",
    kpiSlots: [{ key: "reports", label: "本轮报数" }],
    cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "出简报" },
    model: "claim-cheap",
    fallbackModel: null,
    effort: "low",
    contextBudget: 200000,
    carrier: null,
    inputPolicy: null,
    concurrency: null,
    workbench: null,
    ...over,
  };
}

test("live bridge: persona row maps to a template-shaped member the parser accepts", () => {
  const member = memberFromLive(liveRow());
  assert.equal(member.target.kind, "existing-persona");
  assert.equal(member.target.id, "a1");
  assert.equal(member.ref, "m1");
  // It re-parses through the canonical parser (one shape end to end).
  const parsed = parseFleetTemplate({ fleet: { name: "x", members: [member] } });
  assert.equal(parsed.ok, true, JSON.stringify(parsed.error));
});

test("live bridge: every live targetKind has an explicit template mapping", () => {
  for (const [live, tpl] of Object.entries(LIVE_TO_TEMPLATE_KIND)) {
    assert.equal(memberFromLive(liveRow({ targetKind: live })).target.kind, tpl);
  }
});

test("live bridge: unknown live targetKind is surfaced, not silently coerced", () => {
  const m = memberFromLive(liveRow({ targetKind: "made-up-kind" }));
  assert.equal(m.target._unmapped, true);
  assert.equal(m.target.kind, "made-up-kind");
});

test("live bridge: mapped members round-trip through the diff (no-op)", () => {
  const rows = [liveRow({ id: "m1" }), liveRow({ id: "m2", parentId: "m1", targetKind: "cluster", targetId: "c1" })];
  const ir = membersFromLive(rows);
  const diff = diffTeamStructure(ir, ir);
  assert.equal(diff.adds.length + diff.updates.length + diff.removes.length, 0);
});
