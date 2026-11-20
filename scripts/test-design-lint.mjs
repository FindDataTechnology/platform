#!/usr/bin/env node
// ── design-lint ratchet tests (harden-web-design-foundation 3.3) ─────────────
// Pins the spec's three judgment criteria and the exemption rules:
//   新债即红  — a file+rule count over baseline (or absent from baseline) fails
//   存量不误伤 — counts at or under baseline pass, unrelated edits pass
//   主题引用豁免 — bg-[var(--token)] and color-mix(in .., var(..)) are NOT debt;
//                 a literal smuggled into color-mix IS
// Plus: ui/ exemption, hex-vs-arbitrary non-double-count, hairline border-l
// legal / >=2px illegal, confirm forms, and the live repo scan vs the shipped
// baseline (canary: the gate is green on HEAD).
//
//   node --test scripts/test-design-lint.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanText, shouldScan, compareRatchet, scanTree } from "./design-lint.mjs";

const projectRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");

// ── scanText: per-rule recognition ───────────────────────────────────────────
test("hex literals count as hex-color debt", () => {
  const c = scanText(`const k = "#e0895f"; <div style={{ color: "#000000" }} />`);
  assert.equal(c["hex-color"], 2);
});

test("tailwind arbitrary colors count once, not double as hex", () => {
  const c = scanText(`<div className="bg-[#e0895f] text-[oklch(0.4 0.1 250)]" />`);
  assert.equal(c["tw-arbitrary-color"], 2);
  assert.equal(c["hex-color"], undefined, "hex inside an arbitrary value must not double-count");
});

test("theme references are exempt; literals smuggled into color-mix are not", () => {
  assert.deepEqual(scanText(`className="bg-[var(--color-status-running)]"`), {});
  const c = scanText(`className="bg-[var(--color-status-running)] border-[color-mix(in oklab, oklch(0.5 0 0) 12%, transparent)]"`);
  assert.equal(c["tw-arbitrary-color"], 1, "only the color-mix with a literal is debt");
});

test("size arbitrary values are not color debt", () => {
  const c = scanText(`className="text-[13px] w-[240px] rounded-[10px]"`);
  assert.equal(c["tw-arbitrary-color"], undefined);
});

test("side-tab: 1px hairline legal, >=2px side accent is debt", () => {
  assert.deepEqual(scanText(`className="border-l"`), {});
  const c = scanText(`className="border-l-2 border-r-[3px] p-4 border-l"`);
  assert.equal(c["side-tab-border"], 2);
});

test("native confirm forms all counted, identifiers not mistaken", () => {
  const c = scanText(`window.confirm("x") — if (confirm("y")) — myConfirm(z) — ConfirmDialog(...) — openConfirm()`);
  assert.equal(c["native-confirm"], 2);
});

test("raw rgba( is debt", () => {
  const c = scanText(`boxShadow: "0 0 0 1px rgba(0,0,0,.2)"`);
  assert.equal(c["raw-rgba"], 1);
});

test("named tailwind palette shades are debt; theme tokens are not", () => {
  const c = scanText(`className="bg-emerald-500 text-amber-600 border-violet-300"`);
  assert.equal(c["named-color"], 3);
  assert.deepEqual(
    scanText(`className="bg-primary text-muted-foreground border-border text-status-failed"`),
    {},
    "theme tokens carry no numeric shade and must pass"
  );
});

// ── scan scope: ui/ exemption and file types ─────────────────────────────────
test("ui/ primitives and non-tsx files are exempt", () => {
  assert.equal(shouldScan("web/src/components/ui/button.tsx"), false);
  assert.equal(shouldScan("web/src/components/fleet/FleetCanvas.tsx"), true);
  assert.equal(shouldScan("web/src/pages/FleetsPage.tsx"), true);
  assert.equal(shouldScan("web/src/lib/appCatalog.ts"), false);
  assert.equal(shouldScan("web/src/pages/Notes.md"), false);
});

// ── compareRatchet: the three spec criteria ─────────────────────────────────
test("new debt on a baseline file fails (新债即红)", () => {
  const baseline = { "web/src/pages/A.tsx": { "hex-color": 3 } };
  const scan = new Map([["web/src/pages/A.tsx", { "hex-color": 4 }]]);
  const { newViolations } = compareRatchet(scan, baseline);
  assert.equal(newViolations.length, 1);
  assert.equal(newViolations[0].rule, "hex-color");
});

test("new violation on a file with no baseline entry fails", () => {
  const scan = new Map([["web/src/pages/Brand-new.tsx", { "native-confirm": 1 }]]);
  assert.equal(compareRatchet(scan, {}).newViolations.length, 1);
});

test("counts at or under baseline pass; decrease reports tighten hint (存量不误伤)", () => {
  const baseline = { "web/src/pages/A.tsx": { "hex-color": 3, "native-confirm": 2 } };
  const scan = new Map([["web/src/pages/A.tsx", { "hex-color": 3 }]]);
  const { newViolations, tightened } = compareRatchet(scan, baseline);
  assert.equal(newViolations.length, 0);
  assert.deepEqual(tightened, [{ file: "web/src/pages/A.tsx", rule: "native-confirm", found: 0, allowed: 2 }]);
});

test("editing an unrelated file that is not in the scan set passes", () => {
  // The --changed CLI compares only git-diff files against the full baseline;
  // an untouched baseline file never appears in that subset, so it cannot fail.
  const baseline = { "web/src/pages/Untouched.tsx": { "hex-color": 9 } };
  const changedScan = new Map([["web/src/pages/Edited.tsx", {}]]);
  assert.equal(compareRatchet(changedScan, baseline).newViolations.length, 0);
});

// ── ③ terminal state: native-confirm is FULLY blocked (baseline empty) ──────
test("native-confirm is fully blocked: zero in baseline, any new call fails", () => {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "scripts/design-lint-baseline.json"), "utf8")
  );
  assert.ok(
    !Object.values(baseline).some((c) => c["native-confirm"]),
    "the baseline must not carry native-confirm entries — ③ cleared them all"
  );
  // A fresh call anywhere in scan scope is new debt the gate must catch.
  const scan = new Map([["web/src/pages/Whatever.tsx", { "native-confirm": 1 }]]);
  const { newViolations } = compareRatchet(scan, baseline);
  assert.equal(newViolations.length, 1);
  assert.equal(newViolations[0].rule, "native-confirm");
});

// ── canary: live tree vs shipped baseline is green ───────────────────────────
test("repo scan has no violations over the shipped baseline", () => {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "scripts/design-lint-baseline.json"), "utf8")
  );
  const scan = scanTree(path.join(projectRoot, "web", "src"));
  const { newViolations } = compareRatchet(scan, baseline);
  assert.equal(
    newViolations.length,
    0,
    `shipped baseline drifted:\n${newViolations.map((v) => `  ${v.file} ${v.rule} ${v.found}>${v.allowed}`).join("\n")}`
  );
});
