#!/usr/bin/env node
// The e2e red-budget gate decides whether a lane's reds are NEWS or known
// noise, so its own failure modes matter more than most (2026-11-15).
//
// Three ways it could lie, all of them the family this repo keeps digging out:
//   * a report from a lane that barely started has zero failed specs → "clean";
//   * a red in a file with no flake history is a regression → must be red here;
//   * a stale allowlist entry silently absorbs a regression forever → the
//     ledger must say, every run, which listed files actually ran clean.
//
// These drive the REAL script against synthetic Playwright reports (its actual
// input shape), so the assertions are on the gate's decisions, not on a
// re-implementation of them.
//
// Run: node scripts/test-e2e-budget-gate.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "check-e2e-budget.mjs");
const tmp = mkdtempSync(path.join(os.tmpdir(), "e2e-budget-"));

let seq = 0;
function report({ specs, unexpected = 0 }) {
  const file = path.join(tmp, `report-${++seq}.json`);
  const suites = specs.map((s) => ({
    file: s.file,
    specs: [{ file: s.file, title: s.title ?? "case", tests: [{ results: s.results }] }],
  }));
  writeFileSync(file, JSON.stringify({ suites, stats: { expected: specs.length, unexpected } }));
  return file;
}

// `n` files, all passing — enough to clear the lane floor. `from` offsets the
// file names so two shard fixtures don't collide on the same basenames
// (observed is a Set of basenames; two shards writing lane-0.spec.js would
// silently merge into one file and fake a short union).
function passingLane(n, from = 0) {
  return Array.from({ length: n }, (_, i) => ({ file: `lane-${from + i}.spec.js`, results: [{ status: "passed" }] }));
}

function run(file, env = {}) {
  try {
    const out = execFileSync(process.execPath, [GATE, ...(Array.isArray(file) ? file : [file])], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, E2E_MIN_SPEC_FILES: "1", ...env },
    });
    return { status: 0, out };
  } catch (err) {
    return { status: err.status ?? 1, out: `${err.stdout || ""}${err.stderr || ""}` };
  }
}

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err?.message || err).split("\n").join("\n       ")}`);
  }
};

check("a clean lane passes and states how many listed files ran clean", () => {
  const r = run(report({ specs: passingLane(3) }));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /e2e lane clean/);
  assert.match(r.out, /known-flaky ledger:/);
});

check("a red in a file with no flake history is a regression", () => {
  const r = run(
    report({
      specs: [...passingLane(2), { file: "brand-new.spec.js", results: [{ status: "failed" }] }],
      unexpected: 1,
    }),
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no flake history: brand-new\.spec\.js/);
});

check("a red in a listed file, inside the budget, passes but says it was hit", () => {
  const r = run(
    report({
      specs: [...passingLane(2), { file: "session-open.spec.js", results: [{ status: "failed" }, { status: "passed" }] }],
      unexpected: 1,
    }),
  );
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /in files with flake history/);
});

// The defect this pins (2026-11-15): `ledger()` used to live inside the
// `unexpected === 0` branch, so the ONE run that produced a red printed no
// ledger at all — the run where knowing "which listed files ran clean" is the
// whole point. It printed on clean runs and stayed silent on the interesting
// ones: the "success says nothing" shape this gate exists to prevent.
check("the ledger also prints on a run that has reds inside the budget", () => {
  const r = run(
    report({
      specs: [
        ...passingLane(2),
        { file: "auth-catalog.spec.js", results: [{ status: "passed" }] },
        { file: "fleets.spec.js", results: [{ status: "passed" }] },
        { file: "session-open.spec.js", results: [{ status: "failed" }] },
      ],
      unexpected: 1,
    }),
  );
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /known-flaky ledger:/, "a red run must still report the ledger");
  const counts = /known-flaky ledger: (\d+) ran clean, (\d+) went red/.exec(r.out);
  assert.ok(counts, `ledger line missing its counts:\n${r.out}`);
  assert.equal(counts[1], "2", "auth-catalog + fleets ran clean and must be counted as such");
  assert.equal(counts[2], "1");
});

// Entries dropped on 2026-11-15 (onboarding, pack-usage) must not creep back in
// by accident: if either reddens it is a regression now, and the gate must say
// so instead of tolerating it.
check("a dropped entry reddening is a regression, not a tolerated flake", () => {
  const r = run(
    report({
      specs: [...passingLane(2), { file: "onboarding.spec.js", results: [{ status: "failed" }] }],
      unexpected: 1,
    }),
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no flake history: onboarding\.spec\.js/);
});

check("a retried-then-passed spec still counts as a red (CI's retries cannot hide a flake)", () => {
  const r = run(
    report({
      specs: [...passingLane(2), { file: "nobody.spec.js", results: [{ status: "failed" }, { status: "passed" }] }],
      unexpected: 0,
    }),
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no flake history: nobody\.spec\.js/);
});

check("a report from a lane that barely ran is red, not clean", () => {
  const r = run(report({ specs: passingLane(2) }), { E2E_MIN_SPEC_FILES: "100" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /did not run to completion/);
});

check("a missing report is red (the lane never reached the reporter)", () => {
  const r = run(path.join(tmp, "does-not-exist.json"));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no readable e2e report/);
});

// ── Shard aggregation (shard-the-e2e-lane) ──────────────────────────────────

// Two shard reports, one red on the second shard: the aggregate must see it,
// with per-shard attribution — the whole point of keeping N parsers instead of
// a merged report.
check("reds are aggregated across shard reports with shard attribution", () => {
  const shard1 = report({ specs: passingLane(2) });
  const shard2 = report({
    specs: [...passingLane(2), { file: "brand-new.spec.js", results: [{ status: "failed" }] }],
    unexpected: 1,
  });
  const r = run([shard1, shard2]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no flake history: brand-new\.spec\.js/);
  assert.match(r.out, new RegExp(`\\[\\S*${path.basename(shard2)}\\] brand-new\\.spec\\.js`), r.out);
});

check("aggregate greens read as clean and state the shard count", () => {
  const shard1 = report({ specs: passingLane(2, 0) });
  const shard2 = report({ specs: passingLane(2, 2) });
  const r = run([shard1, shard2]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /e2e lane clean \(4 passed, 2 shard reports\)/);
});

// The floor applies to the aggregate: each shard holds ~1/4 of the lane, so a
// per-report floor would reject every honest shard set.
check("the lane floor applies to the aggregate, not per shard", () => {
  const shard1 = report({ specs: passingLane(1, 0) });
  const shard2 = report({ specs: passingLane(1, 1) });
  const r = run([shard1, shard2], { E2E_MIN_SPEC_FILES: "2" });
  assert.equal(r.status, 0, r.out);
});

// Real scale, generated rather than committed: the fast lane is ~137 files and
// the 4-way split measures 34/29/35/39 (2026-11-15, `--list --shard`). Asserting
// only tiny fixtures would leave the shape that actually ships untested — the
// per-shard floor and the default MIN_SPEC_FILES (100) both bite differently at
// 1 file per shard than at 35.
check("four ~35-file shards covering a 140-file lane pass with the default floor", () => {
  const sizes = [34, 29, 35, 39];
  let next = 0;
  const files = [];
  const shardReports = sizes.map((n) => {
    const spec = passingLane(n, next);
    next += n;
    for (const s of spec) files.push(s.file);
    return report({ specs: spec });
  });
  assert.equal(files.length, 137);
  const lane = laneList(files);
  // Default floor (100) — the real one, not the test override.
  const r = run([...shardReports, "--lane", lane], { E2E_MIN_SPEC_FILES: "100" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /shard union matches the lane enumeration \(137 files\)/);
  assert.match(r.out, /e2e lane clean \(137 passed, 4 shard reports\)/);
});

// The completeness rule: a shard report that never arrived must FAIL the gate,
// not be absorbed. The judgement must never be made from the reports that
// happened to arrive.
check("a missing shard report fails the gate naming the missing file", () => {
  const shard1 = report({ specs: passingLane(3) });
  const r = run([shard1, path.join(tmp, "shard-3-never-arrived.json")]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no readable e2e report at .*shard-3-never-arrived\.json/);
  assert.match(r.out, /UNKNOWN without it/, "the message must say why partial aggregation is refused");
});

// Lane enumeration (rule 2). The expectation comes from `--list`, so a shard
// split that quietly drops a file is caught in BOTH directions.
function laneList(files) {
  const file = path.join(tmp, `lane-${++seq}.json`);
  const suites = files.map((f) => ({ file: f, specs: [{ file: f, title: "case", tests: [{}] }] }));
  writeFileSync(file, JSON.stringify({ suites }));
  return file;
}

check("union matches when every lane file was observed by some shard", () => {
  const shard1 = report({ specs: [...passingLane(2, 0), { file: "a.spec.js", results: [{ status: "passed" }] }] });
  const shard2 = report({ specs: [...passingLane(2, 2), { file: "b.spec.js", results: [{ status: "passed" }] }] });
  const lane = laneList(["a.spec.js", "b.spec.js", "lane-0.spec.js", "lane-1.spec.js", "lane-2.spec.js", "lane-3.spec.js"]);
  const r = run([shard1, shard2, "--lane", lane]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /shard union matches the lane enumeration \(6 files\)/);
});

check("a lane file no shard observed is a named failure (dropped by the split)", () => {
  const shard1 = report({ specs: passingLane(2, 0) });
  const shard2 = report({ specs: passingLane(2, 2) });
  const lane = laneList(["a.spec.js", ...passingLane(4).map((s) => s.file)]);
  const r = run([shard1, shard2, "--lane", lane]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /shard union ≠ lane enumeration/);
  assert.match(r.out, /NO shard observed.*a\.spec\.js/);
});

check("a file the shards ran but the lane does not know is a named failure (stale --list)", () => {
  const shard1 = report({ specs: [...passingLane(2, 0), { file: "surprise.spec.js", results: [{ status: "passed" }] }] });
  const shard2 = report({ specs: passingLane(2, 2) });
  const lane = laneList(passingLane(4).map((s) => s.file));
  const r = run([shard1, shard2, "--lane", lane]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not in the lane enumeration.*surprise\.spec\.js/);
});

// An unreadable enumeration is UNDETERMINED, not green (exit 2 — the same
// discipline as every other gate in this repo: missing data is not a pass).
check("an unreadable lane enumeration is undetermined (exit 2), never green", () => {
  const shard1 = report({ specs: passingLane(3) });
  const r = run([shard1, "--lane", path.join(tmp, "lane-list-garbage.json")]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /UNDETERMINED/);
});

// An enumeration that parses but lists NOTHING is the same failure wearing a
// valid JSON shape. Without this rule, an empty lane compared against an empty
// report prints "✓ union matches (0 files)" — a vacuous pass, the same family
// as an empty allowlist reading as a clean run.
check("an empty lane enumeration is refused instead of matching vacuously", () => {
  const shard1 = report({ specs: passingLane(2, 0) });
  const emptyLane = path.join(tmp, `lane-empty-${++seq}.json`);
  writeFileSync(emptyLane, JSON.stringify({ suites: [] }));
  const r = run([shard1, "--lane", emptyLane]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /lists no test files at all/);
  assert.doesNotMatch(r.out, /shard union matches the lane enumeration \(0 files\)/);
});

// With `--lane` the fixed floor drops to a sanity floor (10) because the union
// check is the one that actually knows the lane. That is only safe if a short
// report still fails under a lane — so prove it: 105 of 300 lane files, which
// would have passed the old hardcoded floor of 100, must be refused by the
// union.
check("a short report fails under --lane even though it clears the old floor", () => {
  const partial = report({ specs: passingLane(105, 0) });
  const lane = laneList(passingLane(300, 0).map((s) => s.file));
  const r = run([partial, "--lane", lane]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /shard union ≠ lane enumeration \(300 files expected, 105 observed\)/);
  assert.match(r.out, /NO shard observed/);
});

console.log(`\ne2e red-budget gate: ${passed}/${passed + failed} cases passed`);
if (failed) process.exit(1);
