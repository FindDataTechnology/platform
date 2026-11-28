// Boot-composition test for scoped persona skills (persona-live-via-scoped-
// skills task 2.4 / design D1): with PERSONA_SCOPED_SKILLS=1 the boot writers
// must produce a baseline-ONLY global skills patch AND per-preset scoped skill
// rows carrying each persona's roots. Combined with contract ⑲ (a preset's
// scoped row IS delivered to its session), this closes the boot path locally.
//
// DSH_HOME is set BEFORE importing dsh-profile.js because its module-level path
// constants are computed from env at load — the same discipline the contracts
// runner follows.
//
// Run: node --test scripts/test-persona-scoped-boot.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

const home = mkdtempSync(join(tmpdir(), "scoped-boot-"));
process.env.DSH_HOME = home;
process.env.PERSONA_SCOPED_SKILLS = "1";

const dshProfile = await import("../dsh-profile.js");
const dirs = { dshHome: home, profileName: "platform" };

function readYaml(path) {
  assert.ok(existsSync(path), `expected ${path} to exist`);
  return yaml.load(readFileSync(path, "utf8"));
}

test("flag on: global skills patch is baseline-only (no persona roots)", async () => {
  assert.equal(dshProfile.personaScopedSkillsEnabled(), true);
  await dshProfile.writeSkillsPatch({ dirs, agentPreset: "standard" });
  const doc = readYaml(join(home, "profiles", "platform", "skills.patch.yml"));
  const dirsArr = doc?.[0]?.config?.customSkillDirs ?? [];
  assert.ok(dirsArr.length >= 1, "baseline dir present");
  // The persona's extra roots (MATERIALIZE_DIR / pack roots) must NOT be in the
  // global face in scoped mode — they ride the preset's scoped row instead.
  const materializeDir = (await import("../skill-materialize.js")).MATERIALIZE_DIR;
  assert.ok(!dirsArr.includes(materializeDir), `global skills face leaked the persona root ${materializeDir}: ${dirsArr.join(",")}`);
});

test("flag on: a preset carries its scoped skill-filesystem row", async () => {
  const extPreset = {
    id: "test-alt",
    name: "Test Alt",
    description: "probe preset",
    order: 50,
    persona: "You are a test persona.",
    skillDirs: ["/tmp/persona-extra-root"],
  };
  const standardDirs = await dshProfile.personaSkillDirs("standard");
  await dshProfile.writePresetsPatch({ dirs, extraPresets: [extPreset], skillDirsByPreset: { standard: standardDirs } });
  const doc = readYaml(join(home, "profiles", "platform", "presets.patch.yml"));
  const text = JSON.stringify(doc);
  // The ALT preset's dirs must ride a scoped skill-filesystem row in its composition.
  assert.ok(text.includes("persona-skills"), "expected a persona-skills row in the preset overlay");
  assert.ok(text.includes("/tmp/persona-extra-root"), "expected the ALT preset's skillDirs to ride its scoped row");
});
