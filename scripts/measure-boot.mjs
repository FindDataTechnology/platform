#!/usr/bin/env node
// ── Boot phases, measured honestly ──────────────────────────────────────────
//
// Why this exists (openspec change: unblock-boot-critical-path):
//
// The same command on the same tree measured `listen` at 1.50s, 1.72s, 17.1s and
// 24.4s on 2026-11-24. The spread was not code — it was how many parallel
// sessions shared the CPU. Optimizing against a number that swings 16x is
// guessing, so this script reports the spread and REFUSES to hand back a
// conclusion when the spread is too wide.
//
// Phases (each is a real boundary in server.js, not an estimate):
//   t0  process start
//   t1  module graph evaluated        (last top-level import)
//   t2  routes registered             (52 register*Routes calls)
//   t3  listening                     (server.listen callback)
//   t4  "Platform fully initialized"
//
// Run: node scripts/measure-boot.mjs [--runs 5] [--json]
// Exit 0 always — this is a measurement, not a gate. The REASON it cannot
// conclude is printed on stderr and carried in the JSON.

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Runs server.js once in a child and reports phase timestamps. */
function runOnce(timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const marks = {};
    const t0 = Date.now();
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      const t0 = performance.now();
      const mark = (k) => process.stderr.write("@@MARK@@" + k + " " + (performance.now() - t0).toFixed(0) + "\\n");
      const w = process.stdout.write.bind(process.stdout);
      process.stdout.write = (s, ...a) => {
        const x = String(s);
        if (x.includes("Platform listening")) mark("LISTEN");
        if (x.includes("fully initialized")) mark("INITIALIZED");
        return w(s, ...a);
      };
      process.on("beforeExit", () => mark("BEFORE_EXIT"));
      await import("./server.js");
    `], { cwd: REPO, env: { ...process.env, PLATFORM_DATA_DIR: process.env.PLATFORM_DATA_DIR || "/tmp/measure-boot-data" }, stdio: ["ignore", "ignore", "pipe"] });

    let buf = "";
    child.stderr.on("data", (d) => {
      buf += d.toString();
      for (const m of buf.matchAll(/@@MARK@@(\w+) (\d+)/g)) marks[m[1]] = Number(m[2]);
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("exit", () => {
      clearTimeout(killer);
      // A boot that never reached "listening" is a failed sample, not a fast one.
      resolve(marks.LISTEN ? { ...marks, wallMs: Date.now() - t0 } : null);
    });
  });
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};
const p90 = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)];
};
/** Coefficient of spread: (p90 - min) / median. Above 0.2 the sample is noise. */
const spread = (a) => {
  const m = median(a);
  return m > 0 ? (p90(a) - Math.min(...a)) / m : Infinity;
};

async function main() {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes("--json");
  const runsIdx = argv.indexOf("--runs");
  const runs = runsIdx >= 0 ? Number(argv[runsIdx + 1]) : 5;

  const loadBefore = os.loadavg();
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const s = await runOnce();
    if (s) samples.push(s);
  }
  const loadAfter = os.loadavg();

  if (samples.length === 0) {
    console.error("[measure-boot] no sample reached 'listening' — nothing to measure");
    process.exit(0);
  }

  const phases = ["LISTEN", "INITIALIZED"];
  const report = {
    runs, usable: samples.length,
    loadavgBefore: loadBefore, loadavgAfter: loadAfter,
    phases: {},
    verdict: {},
  };
  for (const p of phases) {
    const vals = samples.filter((s) => s[p] != null).map((s) => s[p]);
    if (vals.length === 0) continue;
    report.phases[p] = { median: median(vals), p90: p90(vals), min: Math.min(...vals), max: Math.max(...vals), spread: spread(vals) };
    report.verdict[p] = report.phases[p].spread > 0.2 ? "UNUSABLE (spread > 20%)" : "usable";
  }

  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`runs=${report.runs} usable=${report.usable}  loadavg ${loadBefore.map((n) => n.toFixed(1)).join(",")} -> ${loadAfter.map((n) => n.toFixed(1)).join(",")}`);
    for (const [p, v] of Object.entries(report.phases)) {
      console.log(`${p.padEnd(12)} median ${String(v.median).padStart(6)}ms  p90 ${String(v.p90).padStart(6)}ms  min ${String(v.min).padStart(6)}ms  max ${String(v.max).padStart(6)}ms  spread ${(v.spread * 100).toFixed(0)}%  ${report.verdict[p]}`);
    }
    const unusable = Object.entries(report.verdict).filter(([, v]) => v.startsWith("UNUSABLE"));
    if (unusable.length) {
      console.error("[measure-boot] REFUSING TO CONCLUDE: " + unusable.map(([k]) => k).join(", ") + " varied too much between runs.");
      console.error("[measure-boot] re-run when the machine is quiet, or compare two builds in the SAME session.");
    }
  }
}

await main();
