#!/usr/bin/env node
// ── Flow attribution passthrough on task records (add-task-flow, tasks 1.1/1.2)
//
// The engine knows nothing about flows. This file pins the ONLY thing it must
// do with the field: persist it verbatim, re-emit it verbatim, restore it
// across a reload, and never let it influence scheduling.
//
// The three assertions that matter, and why each is a distinct failure shape:
//   1. round-trip — a field the engine silently drops looks exactly like a
//      field nobody wrote; only a disk read after reload separates them.
//   2. unknown sub-fields survive — the flow layer owns the shape, so an
//      engine that "tidies" unknown keys is a second, drifting schema.
//   3. scheduling is blind to it — two identical tasks differing only in
//      `flow` must dequeue in arrival order, not in flow order.
//
//   node --test scripts/test-task-flow-passthrough.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Env BEFORE the engine import: TASK_STORAGE_DIR is frozen at module load, and
// a late env silently points the engine at the repository's live cron store
// (found 2026-11-13 in the a2a tests — the reload case was reading 115 real
// tasks instead of the fixture).
const tmpRoot = mkdtempSync(path.join(tmpdir(), "task-flow-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const engine = await import("../task-engine.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const init = () =>
  engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });

test("flow rides the record: passthrough, disk, reload, wire", async () => {
  await init();
  const flow = { flowId: "content", stationId: "gate", sortKey: "a0", verdict: null };
  engine.createManualTask({ prompt: "flow-carrying", persona: "p1", flow });

  await engine.whenTasksPersisted();

  // Disk is the claim: "persisted" is about the FILE, not the live map.
  const onDisk = JSON.parse(readFileSync(path.join(tmpRoot, "jobs.json"), "utf8"));
  const row = onDisk.find((r) => r.prompt === "flow-carrying");
  assert.ok(row, "the task reached the tasks file");
  assert.deepEqual(row.flow, flow, "flow is persisted verbatim");

  // Wire: the client shape must carry it, or no read surface can see a card.
  const wire = engine.listTasks().find((t) => t.prompt === "flow-carrying");
  assert.deepEqual(wire.flow, flow, "flow is emitted on the client shape");

  // Reload: a field that survives in memory but not across a restart is a
  // field that disappears on every deploy.
  await init();
  const reloaded = engine.listTasks().find((t) => t.prompt === "flow-carrying");
  assert.ok(reloaded, "task survives the reload");
  assert.deepEqual(reloaded.flow, flow, "flow survives the reload verbatim");
});

test("unknown sub-fields are not tidied away by the engine", async () => {
  await init();
  // The flow layer may add keys the engine has never heard of. An engine that
  // normalizes them away is a second schema definition in disguise.
  const flow = { flowId: "x", futureKey: { deep: [1, 2] }, anotherOne: "keep me" };
  engine.createManualTask({ prompt: "unknown-keys", persona: "p1", flow });
  await engine.whenTasksPersisted();

  await init();
  const t = engine.listTasks().find((r) => r.prompt === "unknown-keys");
  assert.deepEqual(t.flow, flow, "unknown sub-fields survive verbatim");
});

test("absent flow equals no flow attribution, and changes nothing", async () => {
  await init();
  engine.createManualTask({ prompt: "no-flow", persona: "p1" });
  const t = engine.listTasks().find((r) => r.prompt === "no-flow");
  assert.equal(t.flow, null, "absent flow reads as null, never undefined-shaped noise");
});

test("scheduling is blind to flow", async () => {
  const order = [];
  await engine.initTaskEngine({
    broadcast: () => {},
    isBusy: () => false,
    runTurn: async (t) => {
      order.push(t.prompt);
      return { ok: true };
    },
  });

  // Same target, same trigger, differing only in flow — and a flow value that
  // sorts FIRST alphabetically. If the engine ever consulted it, this order
  // would invert.
  engine.createManualTask({ prompt: "first", persona: "p1", flow: { flowId: "zzz" } });
  engine.createManualTask({ prompt: "second", persona: "p1", flow: { flowId: "aaa" } });

  // Bounded wait on the OBSERVED effect, not a guessed sleep: this repo has
  // been burned twice by sleeps that were really races (see the a2a suite's
  // note). Polling for the two calls is the same wait without the guess.
  for (let i = 0; i < 100 && order.length < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual(order, ["first", "second"], "dequeue order follows arrival, not flow");
});
