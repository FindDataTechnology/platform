#!/usr/bin/env node
// Verify the public-snapshot EXCLUDE_PATHS actually keeps internal artifacts out.
//
// Why a script (and not a one-off command): the exclusion list is a promise, and
// on 2026-11-10 that promise silently stopped holding for `graphify-out/` — a
// 115MB generated code-graph (4811 files) that a merged mirror snapshot brought
// into this worktree's HEAD. `graph.json` records whole-repo file paths, so the
// leak scan flagged it three ways (internal CI / private repo name / internal
// runbook reference) and the build aborted. The release line never carries it,
// so production builds were fine — but any `--ref HEAD` self-check hit the wall,
// which is exactly how a leak check is supposed to be run before shipping.
//
// This runs the real builder (no reimplementation of the exclusion logic) against
// the ref most likely to be dirty, then asserts the produced tree.
//
//   node scripts/verify-snapshot-exclusions.mjs [--ref <ref>] [--keep]
//
// Exit 0 = the snapshot builds AND the excluded paths are absent AND a control
// path is present (so "absent" cannot mean "the build produced nothing").
// Exit 1 = a specific assertion failed; each failure names what it checked.

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const ref = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : "HEAD";
const keep = args.includes("--keep");
const outRel = `dist-opensource/_exclusion-check-${process.pid}`;
const outAbs = join(ROOT, outRel);

// Must live under dist-opensource/ (the builder refuses any other out path).
const MUST_BE_ABSENT = [
  ["graphify-out", "generated code-graph (115MB, records whole-repo paths)"],
  ["graphify-out/graph.json", "the file the leak scan actually flags"],
  ["docs/decision-sheet-2026-11-10.md", "internal decision sheet (cell ids, quota figures)"],
  ["docs/multi-agent-collaboration-explore.md", "internal defect ledger"],
  ["docs/queue-backlog-runbook.md", "internal ops runbook"],
  ["docs/adr", "internal decision records"],
  ["services/ops-console", "internal operator dashboard"],
];
// Paths that MUST survive: proof the build produced a real tree.
// (docs/acceptance-criteria.md is NOT usable — it is itself in the exclusion
// list at make-public-snapshot.mjs:161. The first run of this script picked it
// and the control check failed, which is exactly what a control is for.)
const CONTROLS = ["BUILD-INFO.json", "README.md", "docs/CLUSTER_PLATFORM_QUICKSTART.md"];

const fail = (msg) => { console.error(`  ✗ ${msg}`); failed = true; };
let failed = false;

console.log(`verify-snapshot-exclusions: ref=${ref} out=${outRel}`);
console.log("  (gitleaks skipped — this checks EXCLUDE_PATHS, not secret scanning)");

const run = spawnSync(
  process.execPath,
  ["scripts/make-public-snapshot.mjs", "--init", "--ref", ref, "--out", outRel, "--skip-gitleaks"],
  { cwd: ROOT, encoding: "utf8", timeout: 15 * 60_000 },
);

const tail = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n");
if (run.status !== 0) {
  console.error("  ✗ the builder exited non-zero — fix the build before trusting any exclusion");
  console.error(tail.split("\n").map((l) => `    ${l}`).join("\n"));
  process.exit(1);
}
console.log("  ✓ builder completed");

if (!existsSync(outAbs)) {
  console.error(`  ✗ builder reported success but ${outRel} does not exist`);
  process.exit(1);
}

for (const [rel, why] of MUST_BE_ABSENT) {
  const abs = join(outAbs, rel);
  if (existsSync(abs)) fail(`${rel} leaked into the snapshot — ${why}`);
  else console.log(`  ✓ absent: ${rel}`);
}

for (const c of CONTROLS) {
  if (existsSync(join(outAbs, c))) console.log(`  ✓ control present: ${c}`);
  else fail(`control ${c} is missing — the build produced nothing, so every "absent" above is meaningless`);
}
console.log("  (controls present ⇒ absence above means excluded, not empty)")

if (!keep) rmSync(outAbs, { recursive: true, force: true });
else console.log(`  (kept ${outRel} for inspection)`);

if (failed) {
  console.error("verify-snapshot-exclusions: FAIL");
  process.exit(1);
}
console.log("verify-snapshot-exclusions: PASS");
