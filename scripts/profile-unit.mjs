#!/usr/bin/env node
// ── Per-file unit timing (the ruler for the 63-minute problem) ──────────────
//
// The unit suite takes ~63 min on a cold runner, and the cost is CONCENTRATED:
// 58 of 489 files spawn a real server or a dsh child, and each pays child boot.
// Node's reporters do not label results with the source file (TAP top-level
// subtests are individual CASES), so the only honest way to rank files is to
// run them one at a time and measure.
//
// This is deliberately a tool, not a CI change: it changes no topology and no
// assertion, so it can be pointed at any subset at any time. The intended use is
// to profile the spawn-heavy files, then decide per file whether to slim its
// boot, move it to its own lane, or leave it — instead of guessing.
//
//   node scripts/profile-unit.mjs                      # auto-select spawn-heavy files
//   node scripts/profile-unit.mjs scripts/test-bots.mjs …  # explicit list
//
// NOTE: never borrow another tree's node_modules for this. These files write
// sqlite stores, and a symlinked dependency tree makes them share one DB with
// whatever else is running — the failure looks like a stable ~300s hang, not a
// lock contention. Copy real deps or run it where they belong.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The tree to profile: the one holding this script by default, or PROFILE_UNIT_ROOT
// when profiling another checkout (the main tree has the real deps).
const REPO = process.env.PROFILE_UNIT_ROOT
  ? path.resolve(process.env.PROFILE_UNIT_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(REPO, "scripts");

const SPAWN_MARKERS = /spawnTestServer|initTaskEngine|attachAgentSession|spawn\(/;

function spawnHeavyFiles() {
  return readdirSync(SCRIPTS)
    .filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
    .filter((f) => SPAWN_MARKERS.test(readFileSync(path.join(SCRIPTS, f), "utf8")))
    .map((f) => path.join("scripts", f));
}

// A profiler that reports every file as FAILED because deps are missing is
// worse than no profiler: it looks like a product signal. Refuse up front.
{
  const nm = path.join(REPO, "node_modules");
  if (!existsSync(nm)) {
    console.error(
      "node_modules missing here — run this where the deps belong (the main tree), not from a\n" +
        "worktree that borrowed none. Reported timings would be meaningless.",
    );
    process.exit(2);
  }
  if (lstatSync(nm).isSymbolicLink()) {
    console.error(
      "node_modules is a SYMLINK: these suites write sqlite stores, so a borrowed dependency\n" +
        "tree makes them share one DB with whatever else is running. That shows up as a stable\n" +
        "~300s hang, not as a lock error. Copy real deps first.",
    );
    process.exit(2);
  }
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : spawnHeavyFiles();
if (!files.length) {
  console.error("no test files matched");
  process.exit(1);
}

console.log(`profiling ${files.length} file(s) — each in its own process, serially\n`);
const rows = [];
for (const file of files) {
  const started = Date.now();
  let ok = true;
  try {
    execFileSync(process.execPath, ["--test", file], { cwd: REPO, stdio: "ignore" });
  } catch {
    ok = false;
  }
  rows.push({ file, ms: Date.now() - started, ok });
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${String(rows.at(-1).ms).padStart(7)}ms  ${file}\n`);
}

rows.sort((a, b) => b.ms - a.ms);
const total = rows.reduce((n, r) => n + r.ms, 0);
console.log(`\ntotal ${(total / 1000).toFixed(1)}s across ${rows.length} file(s); slowest:`);
for (const r of rows.slice(0, 10)) {
  console.log(`  ${String((r.ms / 1000).toFixed(1)).padStart(7)}s  ${r.file}${r.ok ? "" : "   ← FAILED"}`);
}
