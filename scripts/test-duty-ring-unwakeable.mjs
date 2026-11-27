// Unit tests — unwakeable suspended cells (surface-unwakeable-suspended-cells).
//
// Pins the four spec scenarios, one arm each:
//   1. a suspended on_demand cell WITH due work and NO owner identity anywhere
//      ⇒ the ring records bindFailureCount/lastBindFailure (and still skips)
//   2. a cell that HAS an owner is never recorded (no borrowed identity, no
//      false positive on healthy cells)
//   3. a cell with no due work is never recorded (idle ≠ unwakeable — recording
//      those turns the counter into noise nobody can act on)
//   4. a successful wake clears the record; a still-unowned cell keeps counting
// Plus the read face: /healthz's derivation lists exactly the unwakeable ones,
// and cannot disagree with the ring (same rule, one implementation).
//
// Run: node --test scripts/test-duty-ring-unwakeable.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { createDutyRing } = await import("../gateway/duty-ring.js");
const { unwakeableCells, ownerFromCellData } = await import("../lib/cell-lifecycle.js");

const NOW_MS = Date.parse("2026-10-27T11:00:00Z");

function row(over = {}) {
  return {
    cellId: "cell-under-test",
    state: "suspended",
    policy: "on_demand",
    ownerEmail: null,
    bindFailureCount: 0,
    lastBindFailure: null,
    workload: {},
    ...over,
  };
}

// A cron whose next occurrence is already past NOW_MS (starts an hour earlier).
function dueJobs() {
  return [{ id: "job_1", type: "recurring", cron: "0 * * * *", createdAt: "2026-10-27T09:00:00Z", paused: false }];
}
// A cron whose NEXT occurrence is still ahead of NOW_MS (anchored exactly at
// NOW_MS ⇒ next tick is one hour later). Anchoring it earlier would make the
// 11:00 occurrence itself due at 11:00 (`occ <= fromMs`), which is the
// difference between "idle" and "unwakeable" — my first version got this wrong
// and the suite caught it.
function notDueJobs() {
  return [{ id: "job_2", type: "recurring", cron: "0 * * * *", createdAt: "2026-10-27T11:00:00Z", paused: false }];
}

function setup({ rows, jobsByCell = {}, ownerByCell = {}, ensureImpl }) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "unwakeable-"));
  const puts = [];
  const registryDb = { all: () => rows, put: (r) => puts.push(r) };
  for (const [cellId, jobs] of Object.entries(jobsByCell)) {
    const dir = path.join(dataRoot, cellId, "data", "cron-store");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify(jobs));
  }
  for (const [cellId, email] of Object.entries(ownerByCell)) {
    const dir = path.join(dataRoot, cellId, "data");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "owner-groups.json"), JSON.stringify({ email }));
  }
  const wakes = [];
  const ensure = ensureImpl ?? ((u) => { wakes.push(u.email); return Promise.resolve(); });
  const ring = createDutyRing({
    registryDb,
    dataRoot,
    ensure,
    spawnGate: 4,
    wakeCooldownMs: 3600_000,
    tickMs: 60_000,
    now: () => NOW_MS,
    log: { log() {}, warn() {} },
  });
  return { ring, puts, wakes, dataRoot };
}

// ── 1. skip is recorded ─────────────────────────────────────────────────────

test("1: no owner anywhere + due work ⇒ skip is recorded with phase/reason/dueJobs/at", async () => {
  const { ring, puts, wakes } = setup({ rows: [row()], jobsByCell: { "cell-under-test": dueJobs() } });
  await ring.tick();
  assert.deepEqual(wakes, [], "must never spawn blind");
  const rec = puts.filter((p) => p.lastBindFailure).at(-1);
  assert.ok(rec, "the skip must be recorded, not just logged");
  assert.equal(rec.bindFailureCount, 1);
  assert.equal(rec.lastBindFailure.cellId, "cell-under-test", "spec names the cellId in the record");
  assert.equal(rec.lastBindFailure.phase, "wake");
  assert.equal(rec.lastBindFailure.reason, "no_owner_identity");
  assert.equal(rec.lastBindFailure.dueJobs, 1);
  assert.equal(rec.lastBindFailure.at, new Date(NOW_MS).toISOString());
});

test("1b: the counter accumulates while the cell stays unowned", async () => {
  const r = row();
  const { ring, puts } = setup({ rows: [r], jobsByCell: { "cell-under-test": dueJobs() } });
  await ring.tick();
  const first = puts.filter((p) => p.lastBindFailure).at(-1);
  // Second tick sees the registry as it now stands (the ring's own write).
  const { ring: ring2, puts: puts2 } = setup({
    rows: [{ ...r, bindFailureCount: first.bindFailureCount, lastBindFailure: first.lastBindFailure }],
    jobsByCell: { "cell-under-test": dueJobs() },
  });
  await ring2.tick();
  const second = puts2.filter((p) => p.lastBindFailure).at(-1);
  assert.equal(second.bindFailureCount, 2, "still unowned ⇒ still counting");
});

// ── 2. owner ⇒ never recorded ───────────────────────────────────────────────

test("2: registry owner present ⇒ wakes, nothing recorded", async () => {
  const { ring, puts, wakes } = setup({
    rows: [row({ ownerEmail: "owner@example.com" })],
    jobsByCell: { "cell-under-test": dueJobs() },
  });
  await ring.tick();
  assert.deepEqual(wakes, ["owner@example.com"]);
  assert.equal(puts.filter((p) => p.lastBindFailure).length, 0);
});

test("2b: owner recovered from the cell's own data ⇒ wakes, nothing recorded", async () => {
  const { ring, puts, wakes } = setup({
    rows: [row()],
    jobsByCell: { "cell-under-test": dueJobs() },
    ownerByCell: { "cell-under-test": "recovered@example.com" },
  });
  await ring.tick();
  assert.deepEqual(wakes, ["recovered@example.com"]);
  assert.equal(puts.filter((p) => p.lastBindFailure).length, 0);
});

test("2c: another cell's skip does not touch a wakeable cell", async () => {
  const { ring, puts, wakes } = setup({
    rows: [row({ cellId: "dead" }), row({ cellId: "alive", ownerEmail: "owner@example.com" })],
    jobsByCell: { dead: dueJobs(), alive: dueJobs() },
  });
  await ring.tick();
  assert.deepEqual(wakes, ["owner@example.com"]);
  const recorded = puts.filter((p) => p.lastBindFailure).map((p) => p.cellId);
  assert.deepEqual(recorded, ["dead"]);
});

// ── 3. no due work ⇒ not recorded ───────────────────────────────────────────

test("3: no due work ⇒ nothing recorded (idle is not unwakeable)", async () => {
  const { ring, puts } = setup({ rows: [row()], jobsByCell: { "cell-under-test": notDueJobs() } });
  await ring.tick();
  assert.equal(puts.filter((p) => p.lastBindFailure).length, 0);
});

// ── 4. clearing ─────────────────────────────────────────────────────────────

test("4: a successful wake clears the record", async () => {
  const { ring, puts, wakes } = setup({
    rows: [row({ ownerEmail: "owner@example.com", bindFailureCount: 1, lastBindFailure: { phase: "wake", reason: "no_owner_identity", at: "2026-10-27T10:00:00Z", dueJobs: 1 } })],
    jobsByCell: { "cell-under-test": dueJobs() },
  });
  await ring.tick();
  assert.deepEqual(wakes, ["owner@example.com"]);
  const cleared = puts.at(-1);
  assert.equal(cleared.bindFailureCount, 0);
  assert.equal(cleared.lastBindFailure, null);
});

test("4b: a wake that throws does NOT clear the record", async () => {
  const { ring, puts } = setup({
    rows: [row({ ownerEmail: "owner@example.com", bindFailureCount: 3, lastBindFailure: { phase: "wake", reason: "no_owner_identity", at: "2026-10-27T10:00:00Z", dueJobs: 1 } })],
    jobsByCell: { "cell-under-test": dueJobs() },
    ensureImpl: () => Promise.reject(new Error("spawn failed")),
  });
  await ring.tick();
  assert.equal(puts.filter((p) => p.lastBindFailure === null).length, 0, "a failed wake must keep the record");
});

// ── read face ───────────────────────────────────────────────────────────────

test("5: the authoritative list is exactly the unwakeable ones", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "unwakeable-face-"));
  const write = (cellId, jobs) => {
    const dir = path.join(dataRoot, cellId, "data", "cron-store");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "jobs.json"), JSON.stringify(jobs));
  };
  write("dead", dueJobs());
  write("idle", notDueJobs());
  write("running", dueJobs());
  write("owned", dueJobs());
  const cells = unwakeableCells({
    dataRoot,
    nowMs: NOW_MS,
    rows: [
      row({ cellId: "dead" }),
      row({ cellId: "idle" }),
      row({ cellId: "running", state: "running" }),
      row({ cellId: "owned", ownerEmail: "owner@example.com" }),
      row({ cellId: "tomb", destroy: { reason: "x", at: "2026-10-01T00:00:00Z" } }),
    ],
  });
  assert.deepEqual(cells.map((c) => c.cellId), ["dead"]);
  assert.equal(cells[0].dueJobs, 1);
  assert.equal(cells[0].reason, "no_owner_identity");
});

test("5b: all wakeable ⇒ empty list, not a phantom entry", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "unwakeable-none-"));
  const cells = unwakeableCells({
    dataRoot,
    nowMs: NOW_MS,
    rows: [row({ cellId: "a", ownerEmail: "o@example.com" }), row({ cellId: "b", state: "running" })],
  });
  assert.deepEqual(cells, []);
});

test("5c: the face uses the same owner rule as the ring (one implementation)", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "unwakeable-rule-"));
  const dir = path.join(dataRoot, "c", "data");
  fs.mkdirSync(path.join(dir, "cron-store"), { recursive: true });
  fs.writeFileSync(path.join(dir, "owner-groups.json"), JSON.stringify({ email: "  from-data@example.com  " }));
  fs.writeFileSync(path.join(dir, "cron-store", "jobs.json"), JSON.stringify(dueJobs()));
  assert.equal(ownerFromCellData(dataRoot, "c"), "from-data@example.com", "trimmed");
  assert.deepEqual(unwakeableCells({ rows: [row({ cellId: "c" })], dataRoot, nowMs: NOW_MS }), [],
    "recoverable owner ⇒ the ring will wake it ⇒ must not be listed as unwakeable");
});
