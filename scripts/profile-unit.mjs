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

import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The tree to profile: the one holding this script by default, or PROFILE_UNIT_ROOT
// when profiling another checkout (the main tree has the real deps).
const REPO = process.env.PROFILE_UNIT_ROOT
  ? path.resolve(process.env.PROFILE_UNIT_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(REPO, "scripts");

const SPAWN_MARKERS = /spawnTestServer|initTaskEngine|attachAgentSession|spawn\(/;

// How long one file may take before we kill it and move on. Without this a
// single hung file stalls the whole leaderboard forever — measured 2026-11-16,
// `test-cell-gateway.mjs` sat 7 minutes with nothing printed, and the only way
// to know where it was stuck was `ps -Ao etime,args | grep "node --test"`.
// `unit-shard.mjs --run` already caps each CASE at 180s; a file total needs its
// own, larger bound because one file carries many cases. A timeout is NOT a
// failure: it says "did not finish inside the budget", which is a different
// verdict with a different follow-up (slim the boot vs fix the assertion).
const FILE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.PROFILE_UNIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
})();

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
  // A real directory is not the same as a COMPLETE one. Measured 2026-11-17: a
  // `cp -Rc` of a 1.7G node_modules was still running when the run started, the
  // symlink guard above passed (it IS a real dir), and the leaderboard reported
  // 40+ files as FAIL in 6–8s at ~0.6s CPU — a half-copied tree and a broken
  // suite are indistinguishable in that output. Every direct dependency must
  // resolve before any number this tool prints means anything.
  const pkgPath = path.join(REPO, "package.json");
  if (existsSync(pkgPath)) {
    let pkg = {};
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      pkg = {};
    }
    const wanted = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    const missing = wanted.filter((name) => !existsSync(path.join(nm, name)));
    if (missing.length) {
      console.error(
        `node_modules looks incomplete: ${missing.length} direct dependenc` +
          `${missing.length === 1 ? "y is" : "ies are"} missing (${missing.slice(0, 5).join(", ")}` +
          `${missing.length > 5 ? ", …" : ""}). A half-copied tree makes every spawn-heavy file\n` +
          "fail in seconds, which reads exactly like a broken suite. Finish the copy/install and\n" +
          "re-run — a leaderboard measured on partial deps is worse than no leaderboard.",
      );
      process.exit(2);
    }
  }
}

// How many files run at once. Default 1 (the historical shape, and the one the
// self-tests pin), but the honest measurement of this suite is NOT the serial
// one: CI runs `node --test` over files in parallel, so a serial leaderboard
// reports a wall clock nobody ever pays. 76 files serially cost ~2h on the
// reference box — long enough that the full leaderboard kept not happening.
// CPU (user+sys) stays comparable across jobs; wall becomes "what this costs
// with N in flight", which is labelled in the summary so nobody reads it as the
// serial number.
const JOBS = (() => {
  const raw = Number(process.env.PROFILE_UNIT_JOBS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
})();

const files = process.argv.slice(2).length ? process.argv.slice(2) : spawnHeavyFiles();
if (!files.length) {
  console.error("no test files matched");
  process.exit(1);
}

console.log(`profiling ${files.length} file(s) — each in its own process, ${JOBS} at a time`);
console.log(`per-file budget ${Math.round(FILE_TIMEOUT_MS / 1000)}s (PROFILE_UNIT_TIMEOUT_MS)`);
if (JOBS > 1) {
  console.log(
    `PROFILE_UNIT_JOBS=${JOBS}: wall times below are WITH ${JOBS} files in flight (what CI pays),` +
      ` not the serial cost — rank by CPU, and compare walls only against runs of the same JOBS`,
  );
}
// Wall clock alone cannot rank files on a machine somebody else is using: the
// same file measured 34.5s and 37.9s on load 6.6→7.5, and 122s vs 155s for
// test-agent-runner. CPU seconds (user+sys of the whole child tree) barely move
// with load, so the ranking is taken from CPU and the wall figure is kept for
// "what this costs end to end". Without `/usr/bin/time` we say so and rank by
// wall — a silent fallback would republish the noise as if it were signal.
const TIME_BIN = "/usr/bin/time";
const canMeasureCpu = existsSync(TIME_BIN) && process.env.PROFILE_UNIT_CPU !== "0";
console.log(
  canMeasureCpu
    ? "ranked by CPU seconds (`/usr/bin/time -p`, user+sys); wall shown for context\n"
    : "no /usr/bin/time here — ranking by wall clock, which is load-sensitive; treat small gaps as noise\n",
);
const CPU_REPORT = path.join(os.tmpdir(), `profile-unit-cpu-${process.pid}.txt`);

/** user+sys seconds of the whole child tree, from `/usr/bin/time -p -o <path>`. */
function readCpuSeconds(report) {
  let txt;
  try {
    txt = readFileSync(report, "utf8");
  } catch {
    return null;
  }
  const field = (key) => {
    const m = txt.match(new RegExp(`^${key}\\s+([0-9.]+)\\s*$`, "m"));
    return m ? Number(m[1]) : null;
  };
  const [user, sys] = [field("user"), field("sys")];
  return user === null || sys === null ? null : Number((user + sys).toFixed(2));
}

/** One file, as a promise, so JOBS of them can be in flight at once. */
function measure(file, index) {
  return new Promise((resolve) => {
    const started = Date.now();
    // One report file per slot: with several files in flight a shared path
    // would hand each run whichever numbers landed last.
    const cpuReport = `${CPU_REPORT}.${index}`;
    const cmd = canMeasureCpu ? TIME_BIN : process.execPath;
    const args = canMeasureCpu
      ? ["-p", "-o", cpuReport, process.execPath, "--test", file]
      : ["--test", file];
    const child = spawn(cmd, args, {
      cwd: REPO,
      stdio: "ignore",
      // `node --test <file>` forks the file into its own child process, so killing
      // the direct child would leave the real work running and burning CPU while
      // we move on to the next file. Detached puts the child in its own process
      // group; on timeout we kill the group.
      detached: true,
    });
    let outcome = "ok";
    const timer = setTimeout(() => {
      outcome = "timeout";
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* group already gone */
      }
    }, FILE_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ file, ms: Date.now() - started, cpu: null, outcome: "fail" });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      // An exit AFTER the kill still says "did not finish in the budget": the
      // verdict is decided by why we killed it, not by the code the kill produced.
      if (outcome !== "timeout" && code !== 0) outcome = "fail";
      const cpu = canMeasureCpu ? readCpuSeconds(cpuReport) : null;
      if (canMeasureCpu) {
        try {
          rmSync(cpuReport, { force: true });
        } catch {
          /* best effort */
        }
      }
      resolve({ file, ms: Date.now() - started, cpu, outcome });
    });
  });
}

const rows = [];
let nextFile = 0;
async function worker() {
  while (nextFile < files.length) {
    const index = nextFile++;
    const row = await measure(files[index], index);
    rows.push(row);
    const tag = row.outcome === "ok" ? "ok     " : row.outcome === "timeout" ? "TIMEOUT" : "FAIL   ";
    const cpuTag = row.cpu === null ? "     —" : `${String(row.cpu).padStart(6)}`;
    process.stdout.write(
      `${tag} cpu ${cpuTag}s  wall ${String(row.ms).padStart(7)}ms  ${row.file}\n`,
    );
  }
}
await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, worker));

// Rank by CPU when we have it: it is the load-invariant number, and the whole
// point of this leaderboard is to survive being run on a busy machine.
rows.sort((a, b) => (canMeasureCpu ? (b.cpu ?? 0) - (a.cpu ?? 0) : b.ms - a.ms));
const total = rows.reduce((n, r) => n + r.ms, 0);
const totalCpu = rows.reduce((n, r) => n + (r.cpu ?? 0), 0);
const timedOut = rows.filter((r) => r.outcome === "timeout");
const failed = rows.filter((r) => r.outcome === "fail");
console.log(
  `\ntotal wall ${(total / 1000).toFixed(1)}s` +
    (JOBS > 1 ? ` (${JOBS} in flight)` : "") +
    (canMeasureCpu ? ` / cpu ${totalCpu.toFixed(1)}s` : "") +
    ` across ${rows.length} file(s)` +
    ` — ok ${rows.length - timedOut.length - failed.length} / fail ${failed.length} / timeout ${timedOut.length}`,
);
if (timedOut.length) {
  console.log(
    `  ⚠ ${timedOut.length} 个文件没在 ${Math.round(FILE_TIMEOUT_MS / 1000)}s 内跑完：` +
      `这不是失败，是「没跑完」——它的耗时只能给下界，榜单里要单独看`,
  );
}
// Two views, because they point at different fixes. Wall is what the suite costs
// (so those files are the ones to attack), but on a busy box wall inflates and
// CPU does not. The ratio separates "burns the machine" from "spends its life
// waiting on a spawned child" — and those have opposite remedies: make the code
// cheaper vs remove the waiting. Measured 2026-11-17: test-agent-runner 144.5s
// wall against 6.94s CPU (21x) — shaving CPU there would change almost nothing.
const wallTop = [...rows].sort((a, b) => b.ms - a.ms).slice(0, 10);
console.log("最贵（按墙钟 —— 该修的是这些）:");
for (const r of wallTop) {
  const note = r.outcome === "ok" ? "" : r.outcome === "timeout" ? "   ← 超时，耗时只是下界" : "   ← FAILED";
  const cpu = r.cpu === null ? "" : `cpu ${String(r.cpu).padStart(6)}s  `;
  const amp = r.cpu === null || r.cpu <= 0 ? "" : `  ×${(r.ms / 1000 / r.cpu).toFixed(0)} 等待放大`;
  console.log(`  ${cpu}wall ${String((r.ms / 1000).toFixed(1)).padStart(7)}s  ${r.file}${amp}${note}`);
}
if (canMeasureCpu) {
  const waited = [...rows]
    .filter((r) => r.cpu !== null && r.cpu > 0)
    .map((r) => ({ ...r, amp: r.ms / 1000 / r.cpu }))
    .sort((a, b) => b.amp - a.amp)
    .slice(0, 10);
  if (waited.length) {
    console.log("等待放大最多（wall÷cpu —— 修法是削等待/少起子进程，不是优化计算）:");
    for (const r of waited) {
      console.log(
        `  ×${String(r.amp.toFixed(0)).padStart(3)}  cpu ${String(r.cpu).padStart(6)}s  wall ${String((r.ms / 1000).toFixed(1)).padStart(7)}s  ${r.file}`,
      );
    }
  }
}
