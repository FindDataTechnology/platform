#!/usr/bin/env node
// ── The tracked-artifact gate, both proofs ──────────────────────────────────
//
// specs/release-gate-integrity requires a red proof and a negative control for
// any gate that sits on a dependency boundary. This pins both for
// scripts/check-tracked-artifacts.mjs, so the gate cannot silently degrade into
// "always green" (someone deletes FORBIDDEN) or "always red" (someone makes the
// control path untracked).
//
// Run: node --test scripts/test-tracked-artifacts.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkTracked, FORBIDDEN, MUST_TRACK } from "./check-tracked-artifacts.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" });

test("negative control: an always-tracked path is tracked", () => {
  // Without this, "the gate found nothing" cannot be distinguished from
  // "the gate is looking at the wrong working tree".
  for (const p of MUST_TRACK) {
    assert.ok(git("ls-files", "--", p).trim().length > 0, `${p} must be tracked — it is the control path`);
  }
});

test("the gate names what it forbids", () => {
  assert.ok(FORBIDDEN.length > 0, "an empty FORBIDDEN list makes the gate unconditionally green");
  for (const f of FORBIDDEN) {
    assert.ok(f.path.endsWith("/"), `${f.path} should be a directory path`);
    assert.ok(f.why && f.why.length > 20, `${f.path} needs a real reason, not a placeholder`);
  }
});

test("the repo is currently clean of forbidden artifacts", () => {
  const { forbidden, missing } = checkTracked();
  assert.deepEqual(forbidden.map((f) => f.path), [], "a forbidden path is tracked again");
  assert.deepEqual(missing, [], "a control path stopped being tracked");
});

test("red proof: the gate is red when a forbidden path is in the index", () => {
  // Re-track one entry into the INDEX ONLY and prove the gate sees it. This is
  // the only way to show the red branch works after the tree was cleaned —
  // running it on the pre-fix tree is not available to a later commit.
  //
  // The entry is FABRICATED rather than taken from `HEAD^`: the public CI repo
  // is a single synthesized snapshot commit with no parent, so a history-based
  // fixture made this test pass locally (full history) and fail in CI (no
  // `HEAD^`). Measured 2026-11-24. The gate's judge is `git ls-files`, which
  // does not care whether the blob exists in any commit — so the hash can be
  // any well-formed object id.
  const sample = "graphify-out/red-proof-probe.json";
  // Not all-zero: git refuses a "null sha1" cache entry outright.
  const fakeBlob = "1".repeat(40);

  git("update-index", "--add", "--cacheinfo", `100644,${fakeBlob},${sample}`);
  try {
    const { forbidden } = checkTracked();
    assert.equal(forbidden.length, 1, "the gate must go red when the path is back in the index");
    assert.equal(forbidden[0].path, "graphify-out/");
    assert.ok(forbidden[0].count >= 1);
  } finally {
    git("update-index", "--force-remove", sample);
  }
  const after = checkTracked();
  assert.deepEqual(after.forbidden, [], "cleanup: the index must return to clean");
});
