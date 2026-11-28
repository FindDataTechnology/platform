#!/usr/bin/env node
// ── Pack version-note validation (add-facet-version-history, tasks 1.1/1.2) ──
//
// validatePackManifest's notes block: optional string, ≤500 chars, immutable
// with the published version. The gateway publish path and the cell install
// path (pack-store.js) consume this same validator, so these tests pin both
// surfaces' contract without a live facet.
//
//   node --test scripts/test-pack-notes-validation.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePackManifest } from "../lib/pack-manifest.js";

const BASE = {
  name: "T",
  skills: [{ name: "s", description: "d", content: "c" }],
  mcpServers: [],
  agents: [],
};

test("a manifest with a valid note validates clean", () => {
  const errors = validatePackManifest({ ...BASE, notes: "修复检索超时；新增两条示例。" });
  assert.equal(errors.length, 0);
});

test("a manifest without notes is unaffected", () => {
  assert.equal(validatePackManifest(BASE).length, 0);
});

test("an over-long note is rejected", () => {
  const errors = validatePackManifest({ ...BASE, notes: "x".repeat(501) });
  assert.ok(errors.some((e) => e.error.includes("notes must be a string of at most 500")));
});

test("a non-string note is rejected", () => {
  const errors = validatePackManifest({ ...BASE, notes: 42 });
  assert.ok(errors.some((e) => e.error.includes("notes must be a string")));
});

test("a note at exactly the limit validates clean", () => {
  const errors = validatePackManifest({ ...BASE, notes: "x".repeat(500) });
  assert.equal(errors.length, 0);
});
