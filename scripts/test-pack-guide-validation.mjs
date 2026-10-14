#!/usr/bin/env node
// ── Pack usage-guide validation (add-pack-tutorials-and-wizard, tasks 1.1) ───
//
// validatePackManifest's guide block: exactly three authored steps, per-step
// title/body bounds, full optionality when the field is absent. The gateway
// publish path consumes this validator verbatim (gateway/packs.js), so these
// level tests pin the publish contract without a live facet.
//
//   node --test scripts/test-pack-guide-validation.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePackManifest } from "../lib/pack-manifest.js";

const BASE = {
  name: "T",
  skills: [{ name: "s", description: "d", content: "c" }],
  mcpServers: [],
  agents: [],
};

const guide = (steps) => ({ ...BASE, guide: { steps } });
const step = (title, body) => ({ title, body });

test("a well-formed three-step guide validates clean", () => {
  const errors = validatePackManifest(guide([step("a", "b"), step("c", "d"), step("e", "f")]));
  assert.equal(errors.length, 0);
});

test("a manifest without a guide is unaffected", () => {
  assert.equal(validatePackManifest(BASE).length, 0);
});

test("two steps are rejected", () => {
  const errors = validatePackManifest(guide([step("a", "b"), step("c", "d")]));
  assert.ok(errors.some((e) => e.error.includes("exactly 3")));
});

test("four steps are rejected", () => {
  const errors = validatePackManifest(
    guide([step("a", "b"), step("c", "d"), step("e", "f"), step("g", "h")]),
  );
  assert.ok(errors.some((e) => e.error.includes("exactly 3")));
});

test("an over-long step body is rejected", () => {
  const errors = validatePackManifest(guide([step("a", "x".repeat(501)), step("c", "d"), step("e", "f")]));
  assert.ok(errors.some((e) => e.error.includes("guide step body")));
});

test("an over-long step title is rejected", () => {
  const errors = validatePackManifest(guide([step("x".repeat(61), "b"), step("c", "d"), step("e", "f")]));
  assert.ok(errors.some((e) => e.error.includes("guide step title")));
});

test("empty titles or bodies are rejected", () => {
  const errors = validatePackManifest(guide([step("", "b"), step("c", "d"), step("e", "f")]));
  assert.ok(errors.some((e) => e.error.includes("guide step title")));
});

test("errors name the offending step index", () => {
  const errors = validatePackManifest(guide([step("a", "b"), step("c", "d"), step("", "f")]));
  assert.ok(errors.some((e) => (e.entry || "").includes("guide.steps[2]")));
});
