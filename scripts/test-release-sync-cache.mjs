// Unit tests — release-sync's cached-asset size gate (scripts/release-sync.mjs).
// Run: node --test scripts/test-release-sync-cache.mjs
//
// Found live 2026-10-29: an interrupted download left a 96MB remnant of a
// 332MB dmg in the cache; the old `existsSync` check treated it as cached and
// would have RSYNCED a truncated installer to the dl host. The gate must:
//   1. treat a missing file as absent (download it),
//   2. accept a byte-exact file,
//   3. flag a size mismatch as truncated (re-download, never publish),
//   4. pass unverifiable assets through (defensive — should not happen).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { cacheState } = await import("../scripts/release-sync.mjs");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "release-cache-"));
const stat = (file) => fs.statSync(file).size;

test("1.1 a missing file is absent", () => {
  assert.equal(cacheState(path.join(DIR, "nope.dmg"), 1234, stat), "absent");
  // A stat that throws (permissions, race) is also "absent" — download again.
  assert.equal(cacheState(path.join(DIR, "gone.dmg"), 1234, () => { throw new Error("EACCES"); }), "absent");
});

test("1.2 a byte-exact file is ok", () => {
  const file = path.join(DIR, "ok.dmg");
  fs.writeFileSync(file, Buffer.alloc(332));
  assert.equal(cacheState(file, 332, stat), "ok");
});

test("1.3 a truncated file is flagged (the live bug)", () => {
  const file = path.join(DIR, "truncated.dmg");
  fs.writeFileSync(file, Buffer.alloc(96)); // any wrong size
  assert.equal(cacheState(file, 332525143, stat), "truncated");
});

test("1.4 an asset without a known size is unverifiable (passes, defensively)", () => {
  const file = path.join(DIR, "unknown.dmg");
  fs.writeFileSync(file, "whatever");
  assert.equal(cacheState(file, null, stat), "unverifiable");
});
