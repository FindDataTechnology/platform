// Unit tests — duty ring (add-cell-lifecycle 3.2).
//
// Pins:
//   - a suspended on_demand cell with a DUE persisted schedule gets woken
//     (scan-only decision — jobs.json, never a probe)
//   - no ownerEmail on file → skip with a warn (never spawn blind)
//   - a failed wake arms the cooldown and never doubles the spawn pressure
//   - running / always / tombstoned rows are never the ring's business
//   - the workload refresh lands (cronCount / lastFireAt)
//
// Run: node --test scripts/test-duty-ring.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { createDutyRing } = await import("../gateway/duty-ring.js");
const { newRegistryRow } = await import("../lib/cell-registry.js");

const NOW_MS = Date.parse("2026-10-27T11:00:00Z");
const HOUR = 3600_000;

function setup({ rows, jobsByCell = {}, ensureImpl }) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dutyring-"));
  const puts = [];
  const registryDb = {
    all: () => rows,
    put: (r) => puts.push(r),
  };
  for (const [cellId, jobs] of Object.entries(jobsByCell)) {
    const dir = path.join(dataRoot, cellId, "data", "cron-store");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify(jobs));
  }
  const wakes = [];
  const ensure = ensureImpl ?? ((u) => { wakes.push(u.email); return Promise.resolve(); });
  const logs = [];
  const ring = createDutyRing({
    registryDb,
    dataRoot,
    ensure,
    spawnGate: 4,
    wakeCooldownMs: HOUR,
    tickMs: HOUR,
    now: () => NOW_MS,
    log: { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push("W:" + a.join(" ")) },
  });
  return { ring, wakes, logs, puts };
}

const suspendedRow = (cellId, over = {}) => ({
  ...newRegistryRow({ cellId, ownerEmail: "u@x.y", policy: "on_demand", now: NOW_MS - HOUR }),
  state: "suspended",
  ...over,
});
const cronJob = (lastRunIso) => [{ id: "j1", type: "recurring", cron: "*/5 * * * *", tz: null, paused: false, lastRun: lastRunIso, createdAt: null }];

test("due schedule wakes the suspended cell once per fire window", async () => {
  const { ring, wakes } = setup({
    rows: [suspendedRow("c1a2b3c4d5e6f701")],
    jobsByCell: { c1a2b3c4d5e6f701: cronJob(new Date(NOW_MS - HOUR).toISOString()) },
  });
  await ring.tick();
  assert.deepEqual(wakes, ["u@x.y"]);
});

test("no ownerEmail on file → warn + skip (no blind spawn)", async () => {
  const { ring, wakes, logs } = setup({
    rows: [suspendedRow("c2a2b3c4d5e6f702", { ownerEmail: null })],
    jobsByCell: { c2a2b3c4d5e6f702: cronJob(new Date(NOW_MS - HOUR).toISOString()) },
  });
  await ring.tick();
  assert.deepEqual(wakes, []);
  assert.ok(logs.some((l) => l.includes("no ownerEmail") || l.includes("ownerEmail")), `warned: ${logs}`);
});

test("failed wake arms cooldown; the next tick does not retry", async () => {
  let calls = 0;
  const { ring } = setup({
    rows: [suspendedRow("c3a2b3c4d5e6f703")],
    jobsByCell: { c3a2b3c4d5e6f703: cronJob(new Date(NOW_MS - HOUR).toISOString()) },
    ensureImpl: () => { calls += 1; return Promise.reject(new Error("boom")); },
  });
  await ring.tick();
  await ring.tick();
  assert.equal(calls, 1, "cooldown suppresses the immediate retry");
});

test("running / always / tombstoned rows are untouched", async () => {
  const { ring, wakes } = setup({
    rows: [
      suspendedRow("c4a2b3c4d5e6f704", { state: "running" }),
      suspendedRow("c5a2b3c4d5e6f705", { policy: "always" }),
      suspendedRow("c6a2b3c4d5e6f706", { destroy: { reason: "operator", at: NOW_MS - 1 } }),
    ],
    jobsByCell: {
      c4a2b3c4d5e6f704: cronJob(new Date(NOW_MS - HOUR).toISOString()),
      c5a2b3c4d5e6f705: cronJob(new Date(NOW_MS - HOUR).toISOString()),
      c6a2b3c4d5e6f706: cronJob(new Date(NOW_MS - HOUR).toISOString()),
    },
  });
  await ring.tick();
  assert.deepEqual(wakes, []);
});

test("workload refresh lands: cronCount + lastFireAt persisted alongside the decision", async () => {
  const latestIso = new Date(NOW_MS - 2 * HOUR).toISOString();
  const { ring, puts } = setup({
    rows: [suspendedRow("c7a2b3c4d5e6f707")],
    jobsByCell: { c7a2b3c4d5e6f707: cronJob(latestIso) },
  });
  await ring.tick();
  const wrote = puts.find((r) => r.cellId === "c7a2b3c4d5e6f707");
  assert.ok(wrote, "ring refreshed the row");
  assert.equal(wrote.workload.cronCount, 1);
  assert.equal(wrote.lastDutyRunAt, Date.parse(latestIso));
});
