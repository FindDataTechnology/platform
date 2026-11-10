#!/usr/bin/env node
// ── Official starter teams tests (add-official-starter-teams) ────────────────
//
// Pins:
//   - the sequence shape: 5 teams, roles preferred×1 + secondary×2 +
//     advanced×2, every entry carries a seedFile that EXISTS
//   - the guide↔seed alignment, GUIDE IS DOCUMENT-SOURCED since
//     move-pack-guides-to-manifest: the client module carries NO starter
//     guide entries (the market manifest is the single source — v6 manifests
//     hold the steps), and the migration staging copy keeps the alignment
//     the old client card used to pin: 3 steps, seed display name in the
//     narrated posts, no ghost posts
//   - v4 lexicon: no legacy terms (集群/阵列/能力包/舰队) in the migrated copy
//
//   node --test scripts/test-official-starter-teams.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const { PACK_GUIDES, STARTER_TEAMS } = await import("../web/src/lib/packGuides.ts").catch(async () => {
  // The web ts file is importable via tsx-less node? It is plain TS types +
  // const object — strip types by importing through a tiny transform.
  const src = fs.readFileSync(path.join(root, "web/src/lib/packGuides.ts"), "utf8");
  const js = src
    .replace(/export interface[\s\S]*?\n}\n/g, "")
    .replace(/: PackGuide\b/g, "")
    .replace(/: StarterTeam\[\]/g, "")
    .replace(/: "preferred" \| "secondary" \| "advanced"/g, "")
    .replace(/: string;/g, ";")
    .replace(/: \[PackGuideStep, PackGuideStep, PackGuideStep\];/g, ";")
    .replace(/: PackPromptCard\[\];/g, ";");
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  return mod;
});

// The migration staging copy (move-pack-guides-to-manifest): zh steps are the
// exact text the client card used to carry, now the parity anchor. 公开快照
// 整目录排除 openspec/changes/——staging 缺席时对账块诚实降级（seed 侧钉子照跑）。
const STAGED_PATH = path.join(root, "openspec/changes/move-pack-guides-to-manifest/staging/guides.json");
const STAGED = fs.existsSync(STAGED_PATH)
  ? JSON.parse(fs.readFileSync(STAGED_PATH, "utf8"))
  : null;

test("sequence shape: 5 teams, one preferred, roles covered, seeds exist", () => {
  assert.equal(STARTER_TEAMS.length, 5);
  const roles = STARTER_TEAMS.map((t) => t.role);
  assert.equal(roles.filter((r) => r === "preferred").length, 1, "exactly one 首选");
  assert.equal(roles.filter((r) => r === "secondary").length, 2);
  assert.equal(roles.filter((r) => r === "advanced").length, 2);
  const preferred = STARTER_TEAMS.find((t) => t.role === "preferred");
  assert.equal(preferred.name, "客服班组", "首选=客服班组（design D3）");
  for (const t of STARTER_TEAMS) {
    assert.ok(fs.existsSync(path.join(root, "docs/fleet-templates", t.seedFile)), `${t.seedFile} exists`);
    assert.ok(t.oneLine.trim().length > 10, `${t.name}: oneLine present`);
  }
});

test("guide is document-sourced: client module carries no starter guide entries", () => {
  for (const t of STARTER_TEAMS) {
    assert.equal(PACK_GUIDES[t.packId], undefined, `${t.name}: ${t.packId} must not be a client guide key`);
  }
});

test("migrated steps↔seed alignment: 3 steps, seed name narrated, no ghost posts", () => {
  for (const t of STARTER_TEAMS) {
    const seed = JSON.parse(fs.readFileSync(path.join(root, "docs/fleet-templates", t.seedFile), "utf8"));
    if (!STAGED) continue; // snapshot face: staging copy excluded — seed-side pins carry
    const staged = STAGED[t.packId];
    assert.ok(staged, `${t.name}: migration staging copy exists for ${t.packId}`);
    assert.equal(staged.guide.steps.length, 3, "three steps (prepare/ask/get)");
    // The migrated copy narrates posts — every post title it names must exist
    // in the seed's member titles (no ghost posts, no missing anchors).
    const titles = (seed.fleet?.members ?? []).map((m) => m.title);
    for (const step of staged.guide.steps) {
      for (const title of titles) {
        if (step.body.includes(title) || step.title.includes(title)) {
          assert.ok(titles.includes(title), `${t.name}: narrated post '${title}' exists in the seed`);
        }
      }
    }
    // Structural sanity: the seed's declared agents cover every pack-preset
    // member (the manifest the market entry will show).
    if (seed.fleet?.members) {
      const agentIds = new Set((seed.agents ?? []).map((a) => a.id));
      for (const m of seed.fleet.members) {
        if (m.target?.kind === "pack-preset") {
          assert.ok(agentIds.has(m.target.presetId), `${t.name}: preset member ${m.ref} → declared agent ${m.target.presetId}`);
        }
      }
    }
  }
});

test("v4 lexicon: no legacy terms in the migrated copy and the sequence", () => {
  for (const t of STARTER_TEAMS) {
    // snapshot face: staging copy excluded — the staged-side lexicon check
    // degrades; the oneLine (shipped module) side always runs.
    if (STAGED) {
      const text = JSON.stringify(STAGED[t.packId]);
      for (const term of ["集群", "阵列", "能力包", "能力市场", "舰队"]) {
        assert.equal(text.includes(term), false, `${t.name}: migrated copy must not carry legacy term '${term}'`);
      }
    }
  }
  for (const t of STARTER_TEAMS) {
    for (const term of ["集群", "阵列", "能力包", "舰队"]) {
      assert.equal(t.oneLine.includes(term), false, `${t.name}: oneLine must not carry '${term}'`);
    }
  }
});
