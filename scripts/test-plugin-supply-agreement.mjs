// Unit tests — supply declaration agreement (change harden-plugin-supply-gates,
// task 4.1).
// Run: node --test scripts/test-plugin-supply-agreement.mjs
//
// The two directions are both load-bearing:
//   · a composed bundle with NO declaration is unreviewed, not harmless;
//   · a declared bundle composed nowhere is dead bookkeeping that rots into a lie.
// Plus the exemption that keeps the gate honest: the dsh runtime's own bundles
// (@deepseek-ai/...) are reviewed upstream and are not ours to classify.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkSupplyAgreement, checkRouteExceptions, isUpstreamBundle, UPSTREAM_BUNDLE_PREFIXES } from "../scripts/check-plugin-supply.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function template(bundles) {
  return { dsh: { profile: { bundles } } };
}

test("agreement holds for a composed+declared pair", () => {
  const errors = checkSupplyAgreement({
    template: template(["@deepseek-ai/dsh-base", "@acme/x"]),
    supply: { bundles: [{ name: "@acme/x", contributes: ["service"] }] },
  });
  assert.deepEqual(errors, []);
});

test("a composed bundle without a declaration is refused as unreviewed", () => {
  const errors = checkSupplyAgreement({
    template: template(["@acme/unlisted"]),
    supply: { bundles: [] },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /'@acme\/unlisted' is composed .* but has no contribution declaration/);
  assert.match(errors[0].error, /unreviewed, not harmless/);
});

test("a declared bundle composed nowhere is refused as a dead declaration", () => {
  const errors = checkSupplyAgreement({
    template: template(["@deepseek-ai/dsh-base"]),
    supply: { bundles: [{ name: "@acme/ghost", contributes: ["ui"] }] },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /'@acme\/ghost' is declared .* but composed nowhere/);
});

test("an entry with no permitted class is refused", () => {
  const errors = checkSupplyAgreement({
    template: template(["@acme/x"]),
    supply: { bundles: [{ name: "@acme/x", contributes: ["tool"] }] },
  });
  assert.ok(errors.some((e) => /declares no permitted contribution class/.test(e.error)));
});

test("upstream dsh bundles are exempt from the declaration requirement", () => {
  assert.equal(isUpstreamBundle("@deepseek-ai/dsh-base"), true);
  assert.equal(isUpstreamBundle("@acme/x"), false);
  assert.deepEqual(UPSTREAM_BUNDLE_PREFIXES, ["@deepseek-ai/"]);
  const errors = checkSupplyAgreement({
    template: template(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-llm"]),
    supply: { bundles: [] },
  });
  assert.deepEqual(errors, []);
});

test("a template without the bundle list is refused, not treated as empty", () => {
  const errors = checkSupplyAgreement({ template: {}, supply: { bundles: [] } });
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /no dsh\.profile\.bundles array/);
});

test("the real repository agrees, and the CLI reports it", () => {
  const res = spawnSync(process.execPath, [path.join(REPO, "scripts/check-plugin-supply.mjs")], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /clean — \d+ declared bundle\(s\)/);
});

test("the CLI fails when a composed bundle lacks a declaration", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "supply-check-"));
  try {
    mkdirSync(path.join(dir, "dsh-profile-template"), { recursive: true });
    mkdirSync(path.join(dir, "dsh-matrix"), { recursive: true });
    writeFileSync(
      path.join(dir, "dsh-profile-template", "package.json"),
      JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@acme/sneaky"] } } }),
    );
    writeFileSync(path.join(dir, "dsh-matrix", "plugin-supply.json"), JSON.stringify({ bundles: [] }));
    const res = spawnSync(process.execPath, [path.join(REPO, "scripts/check-plugin-supply.mjs"), "--root", dir], {
      encoding: "utf8",
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /@acme\/sneaky/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── exception ledger (task 4.3) ──────────────────────────────────────────────
// The ledger is checked in the same build gate as the supply declaration: an
// expired exception is dead paperwork that still LOOKS like permission, and a
// malformed one silently grants nothing at runtime.

function ledgerDir(entries) {
  const dir = mkdtempSync(path.join(tmpdir(), "route-ledger-"));
  mkdirSync(path.join(dir, "dsh-matrix"), { recursive: true });
  writeFileSync(path.join(dir, "dsh-matrix", "route-exceptions.json"), JSON.stringify({ exceptions: entries }));
  return dir;
}

test("an absent ledger is valid (no exceptions, nothing to review)", () => {
  assert.deepEqual(checkRouteExceptions(REPO), []);
});

test("a live, fully documented exception passes the build gate", () => {
  const dir = ledgerDir([
    { name: "@acme/x", reason: "pilot", approvedBy: "ops", expiresAt: Date.now() + 86_400_000 },
  ]);
  try {
    assert.deepEqual(checkRouteExceptions(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an expired exception fails the build with its date named", () => {
  const expired = Date.now() - 86_400_000;
  const dir = ledgerDir([{ name: "@acme/x", reason: "pilot", approvedBy: "ops", expiresAt: expired }]);
  try {
    const errors = checkRouteExceptions(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /'@acme\/x' expired at .*re-review it or remove/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an undocumented exception fails the build before it can grant anything", () => {
  const dir = ledgerDir([{ name: "@acme/x", expiresAt: Date.now() + 86_400_000 }]);
  try {
    const errors = checkRouteExceptions(dir);
    assert.ok(errors.some((e) => /needs approvedBy/.test(e.error)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
