// Unit tests — residency policy engine (add-cell-lifecycle, chapter 2).
//
// Pins:
//   - `always` brings the stack up and never drains it
//   - `on_demand` wakes on a persisted due schedule (jobs.json only — zero
//     process probing) and drains after the quiet window
//   - recent control-plane activity blocks the quiet drain
//   - `manual` never starts anything
//
// Run: node --test scripts/test-steward-policy.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { createPolicyEngine } = await import("../supervisor/steward-policy.js");

const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3600_000;

function setup({ policy, jobs = [], quietMs = 15 * 60 * 1000 }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-"));
  fs.mkdirSync(path.join(dataDir, "data", "cron-store"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "data", "cron-store", "jobs.json"), JSON.stringify(jobs));
  const calls = [];
  const supervisor = {
    async start() { calls.push("start"); },
    async stop() { calls.push("stop"); },
    status() { return []; },
  };
  const steward = { policy, running: false };
  const engine = createPolicyEngine({ supervisor, steward, dataDir, quietMs, now: () => NOW });
  return { engine, calls, steward };
}

const job = (over = {}) => ({
  id: "j1",
  type: "recurring",
  cron: "*/5 * * * *",
  tz: null,
  paused: false,
  lastRun: null,
  createdAt: null,
  ...over,
});

test("always starts the stack on tick and keeps it on later ticks", async () => {
  const { engine, calls } = setup({ policy: "always" });
  await engine.tick();
  assert.deepEqual(calls, ["start"]);
  await engine.tick();
  assert.deepEqual(calls, ["start"], "no repeated start once running");
});

test("on_demand wakes on a persisted due schedule, drains after quiet", async () => {
  const { engine, calls } = setup({
    policy: "on_demand",
    jobs: [job({ lastRun: new Date(NOW - HOUR).toISOString() })],
  });
  await engine.tick();
  assert.deepEqual(calls, ["start"], "due occurrence ⇒ wake");
  // Quiet now: last fire is an hour old, no clients — the next tick drains.
  await engine.tick();
  assert.deepEqual(calls, ["start", "stop"]);
});

test("no due occurrence keeps the stack asleep (tz pinned so the assertion is portable)", async () => {
  const { engine, calls } = setup({
    policy: "on_demand",
    // A tz-less row is interpreted in the MACHINE's local time (the same rule
    // the cell's own scheduler follows), so an unpinned fixture would assert
    // one thing on a +08 laptop and another on a UTC runner. Pin the row's tz
    // — 16:50 local fire, next slot tomorrow 09:00 local — and the assertion
    // means the same thing everywhere.
    jobs: [job({ cron: "0 9 * * *", tz: "Asia/Shanghai", lastRun: new Date(NOW - 600_000).toISOString() })],
  });
  await engine.tick();
  assert.deepEqual(calls, [], "the day's only slot is past — nothing due, nothing starts");
});

test("a row's tz is honored: a UTC slot landing right now wakes the stack", async () => {
  const { engine, calls } = setup({
    policy: "on_demand",
    // 08:50Z anchor, 09:00Z slot == NOW: the occurrence is inclusive ⇒ wake.
    // Same cron as the case above, opposite verdict, purely by zone.
    jobs: [job({ cron: "0 9 * * *", tz: "UTC", lastRun: new Date(NOW - 600_000).toISOString() })],
  });
  await engine.tick();
  assert.deepEqual(calls, ["start"], "the 09:00Z occurrence is inside the window ⇒ wake");
});

test("recent control-plane activity blocks the quiet drain", async () => {
  const { engine, calls } = setup({
    policy: "on_demand",
    jobs: [job({ lastRun: new Date(NOW - HOUR).toISOString() })],
  });
  await engine.tick(); // wakes
  engine.noteActivity(); // a client just talked to the steward
  await engine.tick();
  assert.deepEqual(calls, ["start"], "busy client ⇒ no drain");
});

test("manual never starts anything", async () => {
  const { engine, calls } = setup({
    policy: "manual",
    jobs: [job({ lastRun: new Date(NOW - HOUR).toISOString() })],
  });
  await engine.tick();
  assert.deepEqual(calls, []);
});

test("paused rows are invisible to the ring", async () => {
  const { engine, calls } = setup({
    policy: "on_demand",
    jobs: [job({ paused: true, lastRun: new Date(NOW - HOUR).toISOString() })],
  });
  await engine.tick();
  assert.deepEqual(calls, []);
});
