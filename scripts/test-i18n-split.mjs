#!/usr/bin/env node
// ── The i18n split gate, both proofs ────────────────────────────────────────
//
// The gate reads a BUILD PRODUCT (scripts/check-i18n-split.mjs). Its two ways
// to be useless are "probe strings match nothing, so nothing is ever present"
// (always green) and "every locale matches, so it is always red". Both are
// pinned here.
//
// Run: node --test scripts/test-i18n-split.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { probesFor, checkSplit } from "./check-i18n-split.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "web", "dist", "index.html");

test("every supported locale yields a probe that is absent from all others", () => {
  const probes = probesFor();
  const locales = Object.keys(probes);
  assert.deepEqual(locales.sort(), ["en", "es", "fr", "ja", "zh-CN"]);
  for (const [l, probe] of Object.entries(probes)) {
    assert.ok(probe, `${l} produced no probe — that locale would be invisible to the gate`);
    for (const other of locales) {
      if (other === l) continue;
      const otherProbe = probes[other];
      assert.notEqual(probe, otherProbe, `${l} and ${other} share a probe string`);
    }
  }
});

test("the probes really are distinctive: each locale file carries its own and not another's", () => {
  const probes = probesFor();
  const read = (l) => fs.readFileSync(path.join(REPO, "web", "src", "locales", l, "common.json"), "utf8");
  for (const [l, probe] of Object.entries(probes)) {
    assert.ok(read(l).includes(JSON.parse(JSON.stringify(probe))), `${l}'s probe is not in its own file`);
    for (const other of Object.keys(probes)) {
      if (other === l) continue;
      assert.ok(!read(other).includes(JSON.parse(JSON.stringify(probe))), `${l}'s probe leaked into ${other}`);
    }
  }
});

test("missing build is reported as such, never as a pass", () => {
  if (fs.existsSync(DIST)) return; // only meaningful before a build
  const r = checkSplit();
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.includes("not built")), "an absent build must say so, not stay silent");
});
