// Builder tool-face gate at publish (add-team-building-first-run 5.4).
//
// The failure this covers: an official Builder pack shipped with
// `mcpServers: []`. The existing tool-face gate only inspects DECLARED
// references, so zero declarations passed silently — and at runtime "declares
// nothing" means "do not narrow" (dsh-profile faceForPresetFromPacks returns
// null → trimServersToFace safety valve), i.e. the drafting role received the
// FULL tool surface: bash, publish, apply, everything. The spec
// (builder-team-templates) says that surface must not include approval/mint
// tools at all.
//
// Two assertions, both against real authored files rather than copies:
//   1. the four seeds now declare a narrow face that the existing publish gate
//      accepts (so a future edit that empties them turns this red);
//   2. the new gate rejects an empty declaration for an official Builder and
//      leaves every other pack untouched.
//
// Run: node --test scripts/test-builder-face-gate.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toolFaceErrors, toolClosureErrors } from "../lib/publish-tool-gate.js";
import { builderFaceErrors } from "../gateway/pack-publish-gates.js";

const ROOT = new URL("../", import.meta.url);
// The three Builders that own an MCP surface. 分身工坊 is excluded on purpose:
// it is a pure skill guide (output = manifest text), so it declares no server
// and its guarantee is "introduce no tool face" — see the spec requirement.
const SEEDS = [
  { file: "docs/fleet-architect.seed.json", name: "团队架构师", server: "fleet-architect" },
  { file: "docs/blueprint-architect.seed.json", name: "蓝图构造师", server: "blueprint-author" },
  { file: "docs/pack-author.seed.json", name: "智能体作者", server: "pack-author" },
];
const FACADE = "packs/facade-builder/manifest.json";

const read = (file) => JSON.parse(readFileSync(new URL(file, ROOT), "utf8"));

// ── 5.1 shipped seeds declare a narrow, gate-clean face ─────────────────────

for (const seed of SEEDS) {
  test(`${seed.name}: declares ${seed.server} and passes the existing tool-face gate`, () => {
    const manifest = read(seed.file);
    assert.ok(Array.isArray(manifest.mcpServers) && manifest.mcpServers.length > 0, "a Builder must declare its server");
    const ref = manifest.mcpServers.find((m) => m.registryName === seed.server);
    assert.ok(ref, `must reference '${seed.server}'`);
    assert.ok(Array.isArray(ref.allowTools) && ref.allowTools.length > 0, "the declaration must be narrow, not empty");
    assert.equal(toolFaceErrors(manifest).length, 0, "the existing face gate must accept it");
    assert.equal(toolClosureErrors(manifest).length, 0, "skills must not name undeclared tools");
  });
}

test("no Builder declares a write surface it must not have", () => {
  // `fleet_apply` (instantiation), publish, and pause/resume are structurally
  // out of a Builder's reach (fleet-meta-line's write-face ban + the spec's
  // narrow-face requirement). The seeds assert it here so a future "just add
  // it for convenience" edit fails loudly.
  const forbidden = ["fleet_apply", "facet_market_pack_publish", "facet_market_pack_visibility", "fleet_apply_all"];
  for (const seed of [...SEEDS, { file: FACADE, name: "分身工坊" }]) {
    const manifest = read(seed.file);
    const declared = (manifest.mcpServers ?? []).flatMap((m) => (Array.isArray(m.allowTools) ? m.allowTools : []));
    for (const tool of forbidden) {
      assert.ok(!declared.includes(tool), `${seed.name} must not declare '${tool}'`);
    }
  }
});

test("分身工坊 declares no MCP surface at all", () => {
  // Its guarantee is "introduce no tool face" — a declaration would mean the
  // guide depends on a server it does not have.
  const manifest = read(FACADE);
  assert.deepEqual(manifest.mcpServers ?? [], []);
});

// ── 5.4 the gate itself ─────────────────────────────────────────────────────

test("an official Builder with no MCP declaration is rejected", () => {
  for (const seed of SEEDS) {
    const manifest = { ...read(seed.file), mcpServers: [] };
    const errors = builderFaceErrors(manifest, { officialAuthor: true });
    assert.equal(errors.length, 1, `${seed.name} should be rejected`);
    assert.equal(errors[0].code, "builder_face_empty");
    assert.match(errors[0].error, new RegExp(seed.name));
  }
});

test("a missing mcpServers key is rejected the same way", () => {
  const manifest = { name: "团队架构师" };
  assert.equal(builderFaceErrors(manifest, { officialAuthor: true }).length, 1);
});

test("a non-official author is never checked", () => {
  const manifest = { name: "团队架构师", mcpServers: [] };
  assert.deepEqual(builderFaceErrors(manifest, { officialAuthor: false }), []);
});

test("an official NON-Builder pack is never checked", () => {
  // The gate is scoped to the four Builder names; every other official pack
  // (which legitimately may declare no servers) keeps its behavior.
  const manifest = { name: "客服班组", mcpServers: [] };
  assert.deepEqual(builderFaceErrors(manifest, { officialAuthor: true }), []);
});

test("a Builder that DOES declare a face passes the new gate", () => {
  for (const seed of SEEDS) {
    assert.deepEqual(builderFaceErrors(read(seed.file), { officialAuthor: true }), []);
  }
});

test("分身工坊 is never rejected for having no surface", () => {
  const manifest = { ...read(FACADE), mcpServers: [] };
  assert.deepEqual(builderFaceErrors(manifest, { officialAuthor: true }), []);
});
