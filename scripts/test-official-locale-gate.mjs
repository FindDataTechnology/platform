#!/usr/bin/env node
// ── Official assets carry the en secondary locale track (add-official-packs-i18n) ──
//
// The pack-locale-tracks contract makes zh the main track (base fields) and
// secondary languages an optional overlay — but OFFICIAL assets are the shop
// window: an English visitor landing on an official pack must not fall back to
// Chinese. This gate pins, for every official asset in-repo, that the `en`
// overlay exists and covers every display field the zh main track declares:
//
//   - docs/official-packs/*.json      (assistant packs)
//   - packs/*/manifest.json           (official suite/facade packs)
//   - docs/fleet-templates/*.seed.json + docs/fleet-architect.seed.json
//                                     (fleet template seeds: manifest i18n.en
//                                      AND fleet.i18n.en display overlay)
//
// Coverage = name + description + notes (when declared) + every guide step
// (the whole guide or nothing, per the overlay rule) + every declared skill's
// description + every declared agent's name. Seeds additionally cover every
// member title and KPI slot label. Content fields (skill bodies, personas,
// promptTemplate) are deliberately NOT overlaid — single-language by contract.
//
// Run: node --test scripts/test-official-locale-gate.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const assistantFiles = fs
  .readdirSync(path.join(root, "docs", "official-packs"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => path.join(root, "docs", "official-packs", f));
const packFiles = fs
  .readdirSync(path.join(root, "packs"))
  .map((d) => path.join(root, "packs", d, "manifest.json"))
  .filter((p) => fs.existsSync(p));
const seedFiles = [
  ...fs
    .readdirSync(path.join(root, "docs", "fleet-templates"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(root, "docs", "fleet-templates", f)),
  path.join(root, "docs", "fleet-architect.seed.json"),
  // Builder seeds (add-builder-team-templates): official builders ship with
  // the same locale discipline as every other official asset.
  path.join(root, "docs", "blueprint-architect.seed.json"),
  path.join(root, "docs", "pack-author.seed.json"),
];

/** The en overlay must cover every display field the zh main track declares. */
function assertEnCoversManifest(manifest, label) {
  const en = manifest.i18n?.en;
  assert.ok(en && typeof en === "object", `${label}: i18n.en overlay missing`);
  assert.equal(typeof en.name, "string", `${label}: en.name missing`);
  assert.equal(typeof en.description, "string", `${label}: en.description missing`);
  if (typeof manifest.notes === "string") {
    assert.equal(typeof en.notes, "string", `${label}: en.notes missing`);
  }
  if (Array.isArray(manifest.guide?.steps) && manifest.guide.steps.length === 3) {
    assert.ok(Array.isArray(en.guide?.steps) && en.guide.steps.length === 3,
      `${label}: en.guide must carry all 3 steps (whole guide or nothing)`);
    en.guide.steps.forEach((st, i) => {
      assert.equal(typeof st?.title, "string", `${label}: en.guide.steps[${i}].title missing`);
      assert.equal(typeof st?.body, "string", `${label}: en.guide.steps[${i}].body missing`);
    });
  }
  for (const skill of manifest.skills ?? []) {
    assert.equal(typeof en.skills?.[skill.name]?.description, "string",
      `${label}: en.skills['${skill.name}'].description missing`);
  }
  for (const agent of manifest.agents ?? []) {
    assert.equal(typeof en.agents?.[agent.id]?.name, "string",
      `${label}: en.agents['${agent.id}'].name missing`);
  }
}

test("official assistant packs carry a full en overlay", () => {
  assert.ok(assistantFiles.length >= 3, "official-packs dir unexpectedly small");
  for (const file of assistantFiles) assertEnCoversManifest(readJSON(file), path.basename(file));
});

test("official in-repo packs carry a full en overlay", () => {
  assert.ok(packFiles.length >= 3);
  for (const file of packFiles) {
    assertEnCoversManifest(readJSON(file), path.relative(root, file));
  }
});

test("fleet template seeds carry manifest en overlay AND fleet.i18n.en", () => {
  assert.ok(seedFiles.length >= 6);
  for (const file of seedFiles) {
    const label = path.relative(root, file);
    const seed = readJSON(file);
    assertEnCoversManifest(seed, label);
    const fleet = seed.fleet;
    if (!fleet) continue; // architect seed carries no fleet section
    const fen = fleet.i18n?.en;
    assert.ok(fen && typeof fen === "object", `${label}: fleet.i18n.en missing`);
    assert.equal(typeof fen.name, "string", `${label}: fleet.i18n.en.name missing`);
    for (const member of fleet.members ?? []) {
      const ov = fen.members?.[member.ref];
      assert.equal(typeof ov?.title, "string", `${label}: fleet.i18n.en.members['${member.ref}'].title missing`);
      for (const slot of member.kpiSlots ?? []) {
        assert.equal(typeof ov?.kpiSlots?.[slot.key]?.label, "string",
          `${label}: fleet.i18n.en.members['${member.ref}'].kpiSlots['${slot.key}'].label missing`);
      }
    }
  }
});

test("official seeds pass the pack manifest validator", async () => {
  const { validatePackManifest } = await import("../lib/pack-manifest.js");
  for (const file of [...assistantFiles, ...packFiles, ...seedFiles]) {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    const label = path.relative(root, file);
    const errors = validatePackManifest(d);
    assert.deepEqual(errors, [], `${label}: manifest validator red —\n  ${errors.map((e) => e.error ?? JSON.stringify(e)).join("\n  ")}`);
  }
});

test("no overlay declares zh or redefines structural fields", () => {
  for (const file of [...assistantFiles, ...packFiles, ...seedFiles]) {
    const d = readJSON(file);
    const label = path.relative(root, file);
    assert.ok(!("zh" in (d.i18n ?? {})), `${label}: i18n must not declare zh (base fields ARE zh)`);
    const fen = d.fleet?.i18n?.en;
    if (fen) {
      for (const [ref, ov] of Object.entries(fen.members ?? {})) {
        for (const key of Object.keys(ov ?? {})) {
          assert.ok(["title", "kpiSlots"].includes(key),
            `${label}: fleet.i18n.en.members['${ref}'] has non-display key '${key}'`);
        }
      }
    }
  }
});
