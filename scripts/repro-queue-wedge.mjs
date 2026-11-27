#!/usr/bin/env node
// ── Local reproduction: wedged turn → stalled queue → watchdog frees it
//    (fix-cell-turn-throughput 2.4) ──────────────────────────────────────────
//
// Replays the 2026-11-08 live shape in-process: one turn that never settles,
// three tasks queued behind it. Runs the SAME fixture twice — watchdog off
// (pre-fix behaviour) and watchdog on — and prints the queued/started traces so
// the before/after is a recorded artefact, not an assertion I have to be
// believed on.
//
//   node scripts/repro-queue-wedge.mjs
//
// Exit 0 = the reproduction behaved as documented (off: stall, on: advance).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the engine's storage (frozen at module load) before importing it.
process.env.CRON_STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-repro-"));

const engine = await import(path.join(import.meta.dirname, "../task-engine.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = [];

async function run({ watchdogMs, budgetMs, label }) {
  // The storage dir is frozen at module load, so the second init would reload
  // the FIRST round's persisted records and overwrite the in-memory state we
  // just built. Wipe the store between rounds to make each replay independent.
  try {
    fs.rmSync(path.join(process.env.CRON_STORAGE_PATH, "cron-store"), { recursive: true, force: true });
  } catch { /* first round: nothing to wipe */ }

  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: (task) => {
      started.push(task.id);
      // The first task wedges exactly like the live case: it never settles.
      return task.id === "wedge" ? new Promise(() => {}) : Promise.resolve({ ok: true, text: "ok" });
    },
    isBusy: () => false,
    resolveTurnBudget: () => budgetMs,
  });
  engine.insertTask({ id: "wedge", name: "wedge", prompt: "p", trigger: "manual", targetType: "persona" });
  engine.insertTask({ id: "b1", name: "b1", prompt: "p", trigger: "manual", targetType: "persona" });
  engine.insertTask({ id: "b2", name: "b2", prompt: "p", trigger: "manual", targetType: "persona" });

  if (watchdogMs === null) delete process.env.QUEUE_WATCHDOG_MS;
  else process.env.QUEUE_WATCHDOG_MS = String(watchdogMs);

  started.length = 0;
  engine.enqueueExecution("wedge");
  engine.enqueueExecution("b1");
  engine.enqueueExecution("b2");

  await sleep(600);
  const wedge = engine.getRecord("wedge");
  const b1 = engine.getRecord("b1");
  const trace = {
    label,
    watchdogMs,
    wedgeState: wedge.state,
    wedgeError: (wedge.error ?? "").split(" — ")[0] || null,
    b1State: b1.state,
    startedOrder: [...started],
    queueAdvanced: started.includes("b1"),
  };
  delete process.env.QUEUE_WATCHDOG_MS;
  return trace;
}

// `executionQueue` is a module-level singleton: a round whose turn never
// settles leaves a forever-pending promise at the head of the chain, so a
// second round in the SAME process would queue behind it and prove nothing.
// Each round therefore runs in its own child process.
async function runInChild(args) {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, [import.meta.filename, "--round", ...args], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}

const isChild = process.argv.includes("--round");
if (isChild) {
  const [, , , watchdogArg, label] = process.argv;
  const t = await run({ watchdogMs: Number(watchdogArg), budgetMs: 50, label });
  console.log(JSON.stringify(t));
  process.exit(0);
}

const off = await runInChild(["0", "watchdog OFF (pre-fix)"]);
const on = await runInChild(["150", "watchdog ON (fix)"]);

const report = { off, on };
console.log(JSON.stringify(report, null, 2));

const ok =
  off.queueAdvanced === false &&
  off.wedgeState === "running" &&
  on.queueAdvanced === true &&
  on.wedgeState !== "running" &&
  /queue watchdog/.test(on.wedgeError ?? "");

console.log(ok ? "\nREPRO OK — stall reproduced without the watchdog, cleared with it." : "\nREPRO MISMATCH");
process.exit(ok ? 0 : 1);
