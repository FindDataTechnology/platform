// Skill-domain annotation pipeline (add-skill-display-annotations; receipt
// R1=方案 B in docs/skill-annotation-contract-reconciliation.md):
//   - loader discipline for the `skills` key: same validateAnnotation gate,
//     origin ∈ {registry, yizuo-file} required, invalid entries dropped with a
//     warn, cross-key collisions with `entries` drop the skill side
//   - getRepoSkillAnnotation / listRepoSkillAnnotations: one namespace across
//     BOTH domains — consumers look up by name, never by origin
//   - mapSkill merge (registry-bridge): metadata.annotations top-level wins,
//     repo `skills` key backfills, both absent → null; the serializer's
//     metadata.extra fold is deliberately NOT read (accident landing spot)
//   - pack-locale skills block: `name` overrides only when the base entry
//     declares `title`; the slug never moves; zh requests pass through
//
// Runs against the REAL committed market-annotations.json (data-in-tree
// invariant: registry 272 + yizuo-file 6 at receipt time) plus temp fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const liveFile = path.join(repoRoot, "market-annotations.json");

// pack-locale and the loader are zero-dependency leaves — import directly.
const { loadRepoAnnotations, getRepoAnnotation, getRepoSkillAnnotation, listRepoSkillAnnotations, resetRepoAnnotationsCache } =
  await import("../lib/market-annotations.js");
const { projectManifestForLocale } = await import("../lib/pack-locale.js");

function fixtureDir(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-anno-"));
  fs.writeFileSync(path.join(dir, "market-annotations.json"), JSON.stringify(doc));
  process.chdir(dir); // bundledJson prefers the cwd copy
  return dir;
}

const zhTrack = { name: "民事九步法流程", summary: "民事案件九步法会话版。" };
const enTrack = { name: "Civil nine-step workflow", summary: "Nine-step civil session flow." };
const ann = (extra = {}) => ({
  human: { zh: zhTrack, en: enTrack, ja: { name: "民事九步法フロー", summary: "民事事件の九段階フロー。" } },
  provenance: { source: "finddata-supply-annotations", updatedAt: "2026-11-04" },
  ...extra,
});

test("data-in-tree: committed skills key carries both domains with five locales", () => {
  const doc = JSON.parse(fs.readFileSync(liveFile, "utf8"));
  assert.equal(doc.version, 1);
  const skills = doc.skills ?? {};
  assert.ok(Object.keys(skills).length >= 278, `expected >=278 skills, got ${Object.keys(skills).length}`);
  const origins = new Set(Object.values(skills).map((v) => v.origin));
  assert.deepEqual([...origins].sort(), ["registry", "yizuo-file"]);
  for (const [name, val] of Object.entries(skills)) {
    const h = val.annotation.human;
    assert.ok(h.zh?.name && h.zh?.summary, `${name}: zh track incomplete`);
    for (const loc of ["en", "ja", "es", "fr"]) {
      assert.ok(h[loc]?.name && h[loc]?.summary, `${name}: ${loc} track incomplete`);
    }
    // No collision with the server namespace (export guard's twin assertion).
    assert.ok(!(name in (doc.entries ?? {})), `${name} collides with entries`);
  }
});

test("loader: skills load, origin validated, invalid entries dropped without throwing", () => {
  const dir = fixtureDir({
    version: 1,
    entries: { "fd-quant": { annotation: ann() } },
    skills: {
      good: { origin: "registry", annotation: ann() },
      "bad-origin": { origin: "user", annotation: ann() },
      "no-zh": { origin: "yizuo-file", annotation: { human: { en: enTrack } } },
      corrupt: { origin: "registry", annotation: { human: "nope" } },
    },
  });
  try {
    resetRepoAnnotationsCache();
    loadRepoAnnotations(path.join(dir, "market-annotations.json"));
    assert.equal(getRepoSkillAnnotation("good")?.origin, "registry");
    assert.equal(getRepoSkillAnnotation("bad-origin"), undefined);
    assert.equal(getRepoSkillAnnotation("no-zh"), undefined);
    assert.equal(getRepoSkillAnnotation("corrupt"), undefined);
    // One namespace across both domains: server keys are NOT in skills.
    assert.equal(getRepoSkillAnnotation("fd-quant"), undefined);
    assert.ok(listRepoSkillAnnotations().has("good"));
  } finally {
    resetRepoAnnotationsCache();
    process.chdir(repoRoot);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loader: cross-key collision (skills ∩ entries) drops the skill side", () => {
  const dir = fixtureDir({
    version: 1,
    entries: { clash: { annotation: ann() } },
    skills: { clash: { origin: "registry", annotation: ann() }, keep: { origin: "registry", annotation: ann() } },
  });
  try {
    resetRepoAnnotationsCache();
    loadRepoAnnotations(path.join(dir, "market-annotations.json"));
    assert.equal(getRepoSkillAnnotation("clash"), undefined);
    assert.ok(getRepoSkillAnnotation("keep"));
    assert.ok(getRepoAnnotation("clash"));
  } finally {
    resetRepoAnnotationsCache();
    process.chdir(repoRoot);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pack-locale: skills name overrides only with title twin; slug never moves", () => {
  const manifest = {
    name: "测试包",
    description: "描述",
    skills: [
      { name: "civil-nine-step-workflow", title: "民事九步法流程", description: "九步" },
      { name: "bare-skill", description: "无 title" },
    ],
    i18n: {
      en: {
        skills: {
          "civil-nine-step-workflow": { name: "Civil nine-step workflow", description: "Nine steps" },
          "bare-skill": { name: "Should be ignored", description: "no title twin" },
        },
      },
    },
  };
  const en = projectManifestForLocale(manifest, "en");
  const titled = en.skills.find((s) => s.name === "civil-nine-step-workflow");
  const bare = en.skills.find((s) => s.name === "bare-skill");
  // Display name lives in the title slot; the slug (name field) never moves.
  assert.equal(titled.title, "Civil nine-step workflow"); // en override wins
  assert.equal(titled.name, "civil-nine-step-workflow"); // slug zero-change
  assert.equal(titled.description, "Nine steps");
  assert.equal(bare.name, "bare-skill"); // defensive: no title twin → untouched
  assert.equal(bare.title, undefined);
  assert.equal(bare.description, "no title twin");
  // zh request passes through byte-identical (original object, no overlay).
  const zh = projectManifestForLocale(manifest, "zh");
  assert.equal(zh, manifest);
  assert.equal(zh.skills[0].name, "civil-nine-step-workflow");
});

test("pack-locale: skills name with missing locale falls back to zh title", () => {
  const manifest = {
    name: "测试包",
    description: "描述",
    skills: [{ name: "civil-nine-step-workflow", title: "民事九步法流程", description: "九步" }],
    i18n: { ja: { skills: { "civil-nine-step-workflow": { description: "九段階" } } } },
  };
  const ja = projectManifestForLocale(manifest, "ja");
  // ja block has no name override → display falls back to the zh base title.
  assert.equal(ja.skills[0].title, "民事九步法流程");
  assert.equal(ja.skills[0].name, "civil-nine-step-workflow"); // slug intact
  assert.equal(ja.skills[0].description, "九段階");
});
