#!/usr/bin/env node
// ── Why this suite must NOT use `--test-shard` ───────────────────────────────
//
// The unit suite is slow (~63 min on a cold 2-core runner, run 42630983629).
// The obvious fix is `node --test --test-shard=N/M`, and it LOOKS right: with
// two files, shard 1/2 ran only one file's cases. It is not right.
//
// Measured 2026-11-09 with four files and `--test-reporter=tap`: shard 1/2
// executed cases from THREE of them — `--test-shard` partitions the FLATTENED
// test list, not the file list. One file's cases therefore land on different
// runners and run CONCURRENTLY, which is exactly what `--test-concurrency=1`
// exists to prevent (within-file ordering is load-bearing: queue-health's
// "a record left queued on disk does not leak" only means anything because the
// earlier cases in that file ran first).
//
// This test pins the constraint so the next person who reaches for the flag
// finds the reason instead of a green CI that hides a lost invariant.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));

test("test:unit stays serial and per-test-bounded", () => {
  const script = pkg.scripts?.["test:unit"] ?? "";
  assert.match(script, /--test-concurrency=1\b/, "the suite is serial on purpose: files share global state and within-file order");
  assert.match(script, /--test-timeout=\d+/, "a hanging case must fail by name, not eat the job budget");
});

test("test:unit does not use --test-shard (it partitions CASES, not files)", () => {
  const script = pkg.scripts?.["test:unit"] ?? "";
  assert.ok(
    !/--test-shard/.test(script),
    "`--test-shard` splits the flattened case list: one file's cases then run concurrently on " +
      "different runners, destroying the within-file ordering that makes several of these suites " +
      "deterministic. If this suite must be split, partition the FILE LIST (ls scripts/test-*.mjs) " +
      "and assert the union of executed files equals the full list — never rely on --test-shard.",
  );
});
