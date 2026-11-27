// ── builder taxonomy + team-producer convergence (openspec: builder-structure-convergence) ──
//
//   node --test scripts/test-builder-structure-convergence.mjs
//
// Pins three claims with negative self-proofs, because each one silently decays
// if only asserted positively:
//   1. the four product types are complete, mutually exclusive, one producer each;
//   2. the two TEAM producers describe the same team with the same normalized
//      core (reference-form differences are not failures; real diffs are caught);
//   3. expert/facade are explicitly NOT teams — never forced into a roster.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILDER_PRODUCT_TYPES,
  TEAM_PRODUCT_TYPES,
  NON_TEAM_PRODUCT_TYPES,
  classifyArtifact,
  isTeamType,
  producerForType,
  convergeTeamCore,
} from "../lib/builder-taxonomy.js";
import { deriveTeam } from "../lib/team-derivation.js";
import { readFileSync } from "node:fs";

// ── 1. taxonomy ─────────────────────────────────────────────────────────────

test("four types, each with producer/artifact/isTeam", () => {
  const kinds = Object.keys(BUILDER_PRODUCT_TYPES);
  assert.deepEqual(kinds.sort(), ["expert-pack", "facade-pack", "team-live", "team-template"]);
  for (const k of kinds) {
    const e = BUILDER_PRODUCT_TYPES[k];
    assert.ok(typeof e.producer === "string" && e.producer, `${k}.producer`);
    assert.ok(typeof e.artifact === "string" && e.artifact, `${k}.artifact`);
    assert.equal(typeof e.isTeam, "boolean", `${k}.isTeam`);
  }
});

test("team vs non-team split is exactly as specified", () => {
  assert.deepEqual([...TEAM_PRODUCT_TYPES].sort(), ["team-live", "team-template"]);
  assert.deepEqual([...NON_TEAM_PRODUCT_TYPES].sort(), ["expert-pack", "facade-pack"]);
  for (const k of TEAM_PRODUCT_TYPES) assert.equal(isTeamType(k), true);
  for (const k of NON_TEAM_PRODUCT_TYPES) assert.equal(isTeamType(k), false);
});

test("each type maps to exactly one producer, and no two types share a producer", () => {
  const producers = Object.keys(BUILDER_PRODUCT_TYPES).map(producerForType);
  assert.equal(producers.length, new Set(producers).size, "two types must not share a producer");
});

test("unknown type is 'unregistered', never the nearest type", () => {
  const c = classifyArtifact("team-ish");
  assert.equal(c.registered, false);
  assert.equal(c.isTeam, false);
  assert.equal(c.producer, null);
  assert.equal(isTeamType("team-ish"), false);
  assert.equal(producerForType("team-ish"), null);
});

// ── 2. team-producer convergence ────────────────────────────────────────────

function templateTeam() {
  return {
    name: "demo-team",
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
          // self-referential pack-preset: the template's way of naming a1
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
          kpiSlots: [],
        },
      ],
    },
  };
}

// The SAME team, expressed as live member rows (existing-persona naming the same
// agent ids a1/a2 — the reference-form difference that must NOT count as drift).
function liveTeam() {
  return [
    {
      id: "m1",
      title: "分析师",
      parentId: null,
      targetKind: "persona",
      targetId: "a1",
      kpiSlots: [{ key: "reports", label: "本轮报数" }],
      cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "出简报" },
      model: "claim-cheap",
    },
    { id: "m2", title: "编辑", parentId: "m1", targetKind: "persona", targetId: "a2", kpiSlots: [] },
  ];
}

test("same team as template vs live → cores equal (reference form differs, core doesn't)", () => {
  const out = convergeTeamCore({ templateManifest: templateTeam(), liveRows: liveTeam() });
  assert.equal(out.isTeam, true);
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  assert.equal(out.equal, true, `unexpected diffs: ${JSON.stringify(out.diffs, null, 2)}`);
  // and the reference-form difference really was present (so this isn't vacuous)
  assert.equal(templateTeam().fleet.members[0].target.kind, "pack-preset");
  assert.equal(liveTeam()[0].targetKind, "persona");
});

test("NEGATIVE: a real field difference is caught and named", () => {
  const live = liveTeam();
  live[0] = { ...live[0], fallbackModel: "glm-cheap" }; // template side has none
  const out = convergeTeamCore({ templateManifest: templateTeam(), liveRows: live });
  assert.equal(out.equal, false);
  const d = out.diffs.find((x) => x.ref === "m1" && x.field === "fallbackModel");
  assert.ok(d, `expected a m1/fallbackModel diff, got ${JSON.stringify(out.diffs)}`);
});

test("NEGATIVE: a post only one side has is caught as presence drift", () => {
  const live = liveTeam().filter((m) => m.id !== "m2");
  const out = convergeTeamCore({ templateManifest: templateTeam(), liveRows: live });
  assert.equal(out.equal, false);
  assert.ok(out.diffs.some((d) => d.ref === "m2" && d.field === "presence" && d.live === "absent"));
});

test("NEGATIVE: a dropped KPI slot is caught (slots are compared)", () => {
  const live = liveTeam();
  live[0] = { ...live[0], kpiSlots: [] };
  const out = convergeTeamCore({ templateManifest: templateTeam(), liveRows: live });
  assert.equal(out.equal, false);
  assert.ok(out.diffs.some((d) => d.ref === "m1" && d.field === "kpiSlots"));
});

test("an invalid template is reported as a team-shaped error, not a silent pass", () => {
  const bad = templateTeam();
  bad.fleet.members[0].parentRef = "m2"; // cycle
  const out = convergeTeamCore({ templateManifest: bad, liveRows: liveTeam() });
  assert.equal(out.isTeam, true);
  assert.equal(out.ok, false);
  assert.ok(out.errors.length > 0);
});

// ── 3. non-team boundary ────────────────────────────────────────────────────

test("expert-pack and facade-pack are non-team types", () => {
  for (const k of ["expert-pack", "facade-pack"]) {
    assert.equal(classifyArtifact(k).isTeam, false);
    assert.equal(isTeamType(k), false);
  }
});

test("a non-team pack renders as 'undeclared' (no empty roster), per team-derivation", () => {
  // A single-expert pack manifest: agents + skills, NO fleet block.
  const expertManifest = {
    name: "single-expert",
    description: "x",
    agents: [{ id: "only", name: "专家", persona: "你是专家。" }],
  };
  // It is classified non-team AND deriveTeam reports undeclared, not a 0-post team.
  assert.equal(classifyArtifact("expert-pack").isTeam, false);
  assert.equal(deriveTeam(expertManifest).state, "undeclared");
});

test("NEGATIVE: were an expert pack forced through convergeTeamCore, it would NOT fabricate a core", () => {
  const expertManifest = { name: "single-expert", agents: [{ id: "only", name: "x", persona: "y" }] };
  const out = convergeTeamCore({ templateManifest: expertManifest, liveRows: [] });
  // No fleet section → parseFleetTemplate rejects with fleet_missing; the shape
  // surfaces the error rather than inventing an empty team.
  assert.equal(out.ok, false);
  assert.match(JSON.stringify(out.errors), /fleet/);
});

// ── 2.3 real-fixture convergence ────────────────────────────────────────────
//
// The inline fixture above is hand-built, so a "both sides agree" result could be
// self-fulfilling. This drives the REAL shipped seed (team-builder-fleet) as the
// template side, derives the equivalent live rows from it, and demands equality.
test("real seed team-builder-fleet: derived live rows converge on its template core", () => {
  const seed = JSON.parse(readFileSync(new URL("../docs/fleet-templates/team-builder-fleet.seed.json", import.meta.url), "utf8"));
  // Derive live rows from the template: same refs/tree/slots/cadence, targets as
  // live persona rows naming the SAME execution body the template names.
  const live = seed.fleet.members.map((m) => ({
    id: m.ref,
    title: m.title,
    parentId: m.parentRef ?? null,
    targetKind: "persona",
    targetId: m.target.presetId ?? m.target.id,
    kpiSlots: m.kpiSlots ?? [],
    cadence: m.cadence ?? null,
    model: m.model ?? null,
    fallbackModel: m.fallbackModel ?? null,
    effort: m.effort ?? null,
    contextBudget: m.contextBudget ?? null,
  }));
  const out = convergeTeamCore({ templateManifest: seed, liveRows: live });
  assert.equal(out.isTeam, true);
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  assert.equal(out.equal, true, `real seed must converge with its own live projection; diffs: ${JSON.stringify(out.diffs, null, 2)}`);
});
