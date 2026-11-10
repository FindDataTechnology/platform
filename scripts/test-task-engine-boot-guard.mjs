// Readiness gate for the task engine (cold-cell boot race, prod 2026-10-21).
//
// Routes mount before initTaskEngine runs; a task created and run on a cold
// cell reached the serialized chain with no turn executor and failed with
// "turnFn is not a function", while the pre-init insert sat in a map the init
// then replaced. Before init: insert throws, enqueue refuses; after init both
// work. Runs in its own process so the singleton is genuinely un-initialized.
//
// Run: node --test scripts/test-task-engine-boot-guard.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "engine-guard-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
const engine = await import("../task-engine.js");

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test("before init: insertTask throws and enqueueExecution refuses with a retry hint", () => {
  assert.equal(engine.isInitialized(), false);
  assert.throws(
    () => engine.insertTask({ id: "job_pre", prompt: "p", trigger: "schedule", type: "once", when: null, cron: null }),
    /still starting/,
  );
  assert.deepEqual(engine.enqueueExecution("job_pre"), { ok: false, error: "task engine is still starting — retry in a moment" });
});

test("after init: the same calls succeed", async () => {
  fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
  const ran = [];
  await engine.initTaskEngine({ broadcast: () => {}, runTurn: async (t) => { ran.push(t.id); return { ok: true }; }, isBusy: () => false });
  assert.equal(engine.isInitialized(), true);
  engine.insertTask({ id: "job_post", prompt: "p", trigger: "schedule", type: "once", when: null, cron: null, status: "scheduled", paused: false, history: [] });
  const r = engine.enqueueExecution("job_post");
  assert.equal(r.ok, true);
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(ran, ["job_post"], "the turn executor is wired once initialized");
});
