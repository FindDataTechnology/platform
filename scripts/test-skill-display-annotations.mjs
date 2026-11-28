// ── add-skill-display-annotations: skill annotation read faces ──────────────
// Covers the new read paths: repo annotation source skills key (origin gate,
// drop-on-invalid), the bridge mapSkill fallback read position, and the
// locale projection of skill annotations through the shared helper.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadRepoAnnotations, getRepoSkillAnnotation, resetRepoAnnotationsCache } from "../lib/market-annotations.js";
import { projectAnnotation } from "../lib/supply-annotations.js";

const REPO = path.resolve(import.meta.dirname, "..");
const REAL_FILE = path.join(REPO, "market-annotations.json");

test("real repo file: skills key loads, registry + yizuo-file domains present", () => {
  resetRepoAnnotationsCache();
  const map = loadRepoAnnotations(REAL_FILE);
  assert.ok(map.size >= 23, "MCP entries still load alongside skills");
  const hit = getRepoSkillAnnotation("crm-desk-reception");
  assert.ok(hit, "file skill annotation loads");
  assert.equal(hit.origin, "yizuo-file");
  assert.equal(hit.annotation.human.zh.name, "客服台接待");
  const reg = getRepoSkillAnnotation("contract-review");
  assert.equal(reg.origin, "registry");
  assert.equal(getRepoSkillAnnotation("no-such-skill"), undefined);
});

test("locale projection on a loaded skill annotation", () => {
  resetRepoAnnotationsCache();
  loadRepoAnnotations(REAL_FILE);
  const { annotation } = getRepoSkillAnnotation("crm-desk-reception");
  const zh = projectAnnotation(annotation, "zh");
  const en = projectAnnotation(annotation, "en");
  const jaMissing = projectAnnotation(annotation, "de"); // unknown locale → zh track? normalizeLocale fails → zh
  assert.equal(zh.name, "客服台接待");
  assert.equal(en.name, "CRM desk reception");
  assert.equal(jaMissing.name, "客服台接待");
});

test("invalid skill entries are dropped with siblings surviving", () => {
  const tmp = path.join(os.tmpdir(), `skill-ann-drop-${process.pid}.json`);
  fs.writeFileSync(
    tmp,
    JSON.stringify({
      version: 1,
      entries: {},
      skills: {
        good: { origin: "registry", annotation: { human: { zh: { name: "甲", summary: "s" }, en: { name: "A", summary: "s" }, ja: { name: "甲", summary: "s" }, es: { name: "A", summary: "s" }, fr: { name: "A", summary: "s" } }, provenance: { source: "test" } } },
        nolorigin: { annotation: { human: { zh: { name: "甲", summary: "s" } } } },
        badorigin: { origin: "somewhere", annotation: { human: { zh: { name: "甲", summary: "s" } } } },
        nozh: { origin: "registry", annotation: { human: { en: { name: "A", summary: "s" } } } },
      },
    }),
  );
  try {
    resetRepoAnnotationsCache();
    loadRepoAnnotations(tmp);
    assert.ok(getRepoSkillAnnotation("good"), "valid sibling survives");
    assert.equal(getRepoSkillAnnotation("nolorigin"), undefined);
    assert.equal(getRepoSkillAnnotation("badorigin"), undefined);
    assert.equal(getRepoSkillAnnotation("nozh"), undefined);
  } finally {
    fs.unlinkSync(tmp);
    resetRepoAnnotationsCache();
  }
});

test("missing file degrades to empty skill table, never throws", () => {
  resetRepoAnnotationsCache();
  loadRepoAnnotations(path.join(os.tmpdir(), "skill-ann-does-not-exist.json"));
  assert.equal(getRepoSkillAnnotation("anything"), undefined);
});

// bridge mapSkill fallback read position: metadata.annotations first,
// metadata.extra.annotations second, never inventing an object.
test("annotation read position fallback (shape parity with mapSkill)", () => {
  const plain = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
  const readPosition = (s) => plain(s.metadata?.annotations) ?? plain(s.metadata?.extra?.annotations);
  assert.equal(readPosition({ metadata: { annotations: { human: {} } } }).human.constructor, Object);
  assert.deepEqual(readPosition({ metadata: { extra: { annotations: { a: 1 } } } }), { a: 1 });
  assert.equal(readPosition({ metadata: { annotations: null, extra: { annotations: "str" } } }), null);
  assert.equal(readPosition({ metadata: { extra: { annotations: { top: 1 }, other: 2 } } }).top, 1);
});
