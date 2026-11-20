#!/usr/bin/env node
// ── Cell wake admission tests (harden-cell-wake-admission) ──────────────────
//
// Stub-cell harness (test-cell-memory-gate lineage) with a MODEL sampler: the
// fake models the pod honestly enough to exercise the projection math —
// container used = cache + calibrated per-cell contributions of NON-parked
// cells (parked truth read from the durable registry, exactly what a real
// post-park cgroup reads). Covers:
//   1.2 park-time footprint archive (calibrated, cgroup-real, not RSS nominal)
//   2.1 wake projection admits when it fits; refuses when it doesn't
//   2.2 no footprint → current-only judgment, byte-for-byte (no warn spam)
//   2.3 sampler trouble → fail-open admits
//   3.1 eviction chain: idle-most first, one at a time, re-project each;
//       active residents and policy "always" are never candidates
//   3.2 a candidate that cannot be parked is skipped, the chain continues
//   4.1 refusal evidence carries projectedBytes/footprintBytes/evictedCellIds
//
//   node --test scripts/test-cell-wake-admission.mjs

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCellRegistry, userIdFor } from "../gateway/spawner.js";
import { createCellRegistryDb } from "../gateway/cell-registry.js";
import { newRegistryRow } from "../lib/cell-registry.js";
import { evaluateAdmission } from "../lib/proc-memory.js";

const LIMIT = 1_610_612_736; // 1536Mi — the §15.125 pod
const FLOOR = 0.15; // headroom floor: refuse below 15%
const GATEWAY_RSS = 200_000_000;
const CACHE_BYTES = 50_000_000;
const CAL = 0.6; // model's RSS→cgroup shrink (shared pages count once per container)

const STUB = `
import http from "node:http";
const port = Number(process.env.PORT || 0);
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ pid: process.pid, port }));
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;

// Same stub, listening after a delay — holds a wake's reservation window open
// so a second ensure() can race it deterministically (add-wake-budget-admission).
function STUB_SLOW(delayMs) {
  return `import http from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
const port = Number(process.env.PORT || 0);
const releaseDir = process.env.CELL_RELEASE_DIR;
const email = process.env.CELL_USER_EMAIL || "";
const deadline = Date.now() + ${delayMs};
while (releaseDir && email && !existsSync(path.join(releaseDir, "release-" + email)) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50));
}
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ pid: process.pid, port }));
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;
}

// Model sampler: container used is a FUNCTION OF PARKED TRUTH — a cell's
// contribution counts only while its registry row is resident, so an eviction
// that parks a row frees its (calibrated) share on the next sample, the same
// way a real cgroup reads post-park water.
function makeModelSampler({ regDb, limitBytes = LIMIT } = {}) {
  const state = { cellTotals: new Map() }; // cellId → RSS-nominal total
  const sampler = {
    clearCache() { /* model is stateless */ },
    sample() {
      const parked = new Set((regDb.all() ?? []).filter((r) => r.state === "suspended").map((r) => r.cellId));
      const cells = [...state.cellTotals.entries()].map(([cellId, totalBytes]) => ({ cellId, totalBytes, processes: [] }));
      const used =
        CACHE_BYTES +
        cells.filter((c) => !parked.has(c.cellId)).reduce((s, c) => s + c.totalBytes * CAL, 0) +
        GATEWAY_RSS * CAL;
      const _totalScan = cells.reduce((s, c) => s + c.totalBytes, 0) + GATEWAY_RSS;
      return { available: true, sampledAt: Date.now(), cells, gateway: { totalBytes: GATEWAY_RSS, processes: [] }, ungrouped: { totalBytes: 0, processes: [] }, container: { available: true, usedBytes: Math.round(used), limitBytes } };
    },
    admission(threshold, { projectedBytes = null, inflightBytes = null } = {}) {
      return evaluateAdmission({ container: this.sample().container, threshold, projectedBytes, inflightBytes });
    },
  };
  return { sampler, state };
}

// Expected archive value, computed with the same formula archiveFootprint uses.
function expectedFootprint(state, cellId) {
  const cells = [...state.cellTotals.entries()].map(([id, totalBytes]) => ({ cellId: id, totalBytes }));
  const cellRow = cells.find((c) => c.cellId === cellId);
  const totalScan = cells.reduce((s, c) => s + c.totalBytes, 0) + GATEWAY_RSS;
  const used =
    CACHE_BYTES +
    cells.filter((c) => c.cellId === cellId).reduce((s, c) => s + c.totalBytes * CAL, 0) + // only this cell resident
    GATEWAY_RSS * CAL;
  const ratio = Math.min(1, Math.max(0, used / totalScan));
  return Math.round(cellRow.totalBytes * ratio);
}

function makeHarness({ idleReapSecs = 3600, floor = FLOOR, stubDelayMs = 0, wakeDefaultFootprintMb = null, releaseHoldMs = 0, footprintTtlMs = null } = {}) {
  const harness = {};
  harness.ready = (async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "cell-wake-adm-")));
    const stub = path.join(root, "stub-cell.mjs");
    let releaseDir = null;
    if (releaseHoldMs > 0) {
      releaseDir = path.join(root, "releases");
      await mkdir(releaseDir, { recursive: true });
      harness.releaseDir = releaseDir;
    }
    await writeFile(stub, (stubDelayMs > 0 || releaseHoldMs > 0) ? STUB_SLOW(Math.max(stubDelayMs, releaseHoldMs)) : STUB);
    harness.root = root;
    harness.regDb = createCellRegistryDb({ file: path.join(root, "cells-registry.db") });
    const { sampler, state } = makeModelSampler({ regDb: harness.regDb });
    harness.sampler = sampler;
    harness.state = state;
    harness.registry = createCellRegistry({
      dataRoot: path.join(root, "cells"),
      secret: "test-secret",
      startTimeoutMs: 15_000,
      idleReapSecs,
      serverEntry: stub,
      env: { ...process.env, ...(releaseDir ? { CELL_RELEASE_DIR: releaseDir } : {}) },
      registryDb: harness.regDb,
      procMemory: sampler,
      memoryFloor: floor,
      ...(wakeDefaultFootprintMb != null ? { wakeDefaultFootprintMb } : {}),
      ...(footprintTtlMs != null ? { footprintTtlMs } : {}),
    });
    return harness;
  })();
  return harness;
}

function cleanup(harness) {
  return async () => {
    await harness.registry.shutdown();
    await rm(harness.root, { recursive: true, force: true });
  };
}

const userA = { email: "waker@example.com" }; // the waking cell
const userB = { email: "resident@example.com" }; // a resident candidate
const idA = userIdFor(userA.email);
const idB = userIdFor(userB.email);

// Seed a parked waker with an archived footprint (deterministic T2-T8 setup).
function seedParkedWaker(harness, footprintBytes) {
  const row = { ...newRegistryRow({ cellId: idA, ownerEmail: userA.email }), state: "suspended", lastFootprintBytes: footprintBytes, lastFootprintAt: Date.now() };
  harness.regDb.put(row);
}
// Same, for an arbitrary user (5.x reservation tests wake several cells).
function seedParked(harness, user, footprintBytes) {
  const cellId = userIdFor(user.email);
  const row = { ...newRegistryRow({ cellId, ownerEmail: user.email }), state: "suspended", lastFootprintBytes: footprintBytes, lastFootprintAt: Date.now() };
  harness.regDb.put(row);
}

test("1.2 park archives the calibrated cgroup-real footprint (not RSS nominal)", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  harness.state.cellTotals.set(idA, 300_000_000);
  const cell = await harness.registry.ensure(userA);
  assert.equal(cell.state, "running");
  harness.registry.stop(idA, "test park");
  await new Promise((r) => setTimeout(r, 300)); // exit handler parks the row
  const row = harness.regDb.get(idA);
  assert.equal(row.state, "suspended");
  assert.equal(row.lastFootprintBytes, expectedFootprint(harness.state, idA));
  // The calibration actually bites: a raw nominal sum would be 300MB.
  assert.ok(row.lastFootprintBytes < 300_000_000, "calibrated footprint must be below the RSS-nominal sum");
});

test("2.1 wake whose projection fits admits with zero behavior change", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  seedParkedWaker(harness, 50_000_000);
  const cell = await harness.registry.ensure(userA);
  assert.equal(cell.state, "running");
});

test("2.1+4.1 wake projected over the floor refuses BEFORE materialization, evidence carries the projection", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  const footprint = 1_250_000_000; // current 170MB + this projects past the floor line
  seedParkedWaker(harness, footprint);
  await assert.rejects(
    () => harness.registry.ensure(userA),
    (err) => {
      assert.equal(err.code, "memory_floor");
      assert.ok(err.memory.projectedBytes > LIMIT * (1 - FLOOR), "projected over the floor line");
      assert.equal(err.memory.footprintBytes, footprint);
      assert.deepEqual(err.memory.evictedCellIds, []);
      return true;
    },
  );
  // Nothing materialized, the row stays parked, the refusal is durable.
  assert.equal(harness.registry.record(userA), undefined);
  const row = harness.regDb.get(idA);
  assert.equal(row.state, "suspended");
  assert.equal(row.lastGateRefusal.footprintBytes, footprint);
  assert.ok(row.lastGateRefusal.projectedBytes > 0);
  assert.equal(row.lastGateRefusal.evictedCellIds, undefined);
});

test("3.1 projection short → idle resident evicted → wake admits (one eviction, minimal)", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  seedParkedWaker(harness, 1_100_000_000); // current(290MB w/ B resident) + this projects past the floor line
  // Resident B: running, idle way past the reap window, calibrated share 120MB.
  harness.state.cellTotals.set(idB, 200_000_000);
  await harness.registry.ensure(userB);
  harness.registry.cells.get(idB).lastTraffic = Date.now() - 7200_000;
  harness.regDb.put({ ...harness.regDb.get(idB), lastUserTrafficAt: Date.now() - 7200_000 });
  const usedBefore = harness.sampler.sample().container.usedBytes;
  // Model check: current alone fits, the wake's projection does not.
  const headroomBefore = (LIMIT - usedBefore) / LIMIT;
  assert.ok(headroomBefore >= FLOOR, "precondition: current-only admission would allow");
  const cell = await harness.registry.ensure(userA);
  assert.equal(cell.state, "running");
  // B was parked (durable truth), its memory freed.
  assert.equal(harness.regDb.get(idB).state, "suspended");
  assert.ok(harness.sampler.sample().container.usedBytes < usedBefore);
});

test("3.1 active residents are never candidates → refusal with an empty eviction list", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  seedParkedWaker(harness, 1_100_000_000); // current(290MB w/ B resident) + this projects past the floor line
  harness.state.cellTotals.set(idB, 200_000_000);
  await harness.registry.ensure(userB); // lastTraffic = now → active
  await assert.rejects(
    () => harness.registry.ensure(userA),
    (err) => {
      assert.equal(err.code, "memory_floor");
      assert.deepEqual(err.memory.evictedCellIds, []);
      return true;
    },
  );
  assert.equal(harness.regDb.get(idB).state, "running"); // untouched
});

test("3.1 policy always resident is never a candidate", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  seedParkedWaker(harness, 1_100_000_000); // current(290MB w/ B resident) + this projects past the floor line
  harness.state.cellTotals.set(idB, 200_000_000);
  await harness.registry.ensure(userB);
  harness.registry.cells.get(idB).lastTraffic = Date.now() - 7200_000;
  harness.regDb.put({ ...harness.regDb.get(idB), lastUserTrafficAt: Date.now() - 7200_000, policy: "always" });
  await assert.rejects(() => harness.registry.ensure(userA), (err) => err.code === "memory_floor");
  assert.equal(harness.regDb.get(idB).state, "running");
});

test("3.2 a candidate that cannot be parked is skipped; the chain continues", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  seedParkedWaker(harness, 1_100_000_000); // current(290MB w/ B resident) + this projects past the floor line
  // Sabotaged record: a child that cannot be terminated (kill is a no-op,
  // no exit event ever) — stop() survives, terminateChild throws, the chain
  // skips this candidate and continues to the next.
  harness.registry.cells.set("sabotaged000000", {
    userId: "sabotaged000000",
    email: "sabotage@example.com",
    state: "running",
    demo: false,
    startedAt: Date.now() - 9999_000,
    lastTraffic: Date.now() - 7200_000,
    port: 1,
    pid: 1,
    child: { exitCode: null, kill: () => false },
  });
  harness.state.cellTotals.set(idB, 200_000_000);
  await harness.registry.ensure(userB);
  harness.registry.cells.get(idB).lastTraffic = Date.now() - 3600_000 - 60_000; // idle past the window
  const cell = await harness.registry.ensure(userA);
  assert.equal(cell.state, "running"); // the chain reached B despite the sabotage
  assert.equal(harness.regDb.get(idB).state, "suspended");
});

test("3.3 an evicted resident re-waking converges: it may evict others or be refused — never loops", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  // Round 1: A (projected 1.1GB) evicts idle B and gets in.
  seedParkedWaker(harness, 1_100_000_000);
  harness.state.cellTotals.set(idB, 200_000_000);
  await harness.registry.ensure(userB);
  harness.registry.cells.get(idB).lastTraffic = Date.now() - 7200_000;
  await harness.registry.ensure(userA);
  // Round 2: B re-wakes with a big archive while A is ACTIVE (untouchable) →
  // refused, staying parked. Terminal state, no livelock: the refusal is the
  // convergence point the spec names (候选耗尽仍超限 SHALL 拒绝).
  harness.regDb.put({ ...harness.regDb.get(idB), lastFootprintBytes: 1_250_000_000, lastFootprintAt: Date.now() });
  await assert.rejects(
    () => harness.registry.ensure(userB),
    (err) => {
      assert.equal(err.code, "memory_floor");
      assert.deepEqual(err.memory.evictedCellIds, []); // A active — zero candidates
      return true;
    },
  );
  assert.equal(harness.regDb.get(idB).state, "suspended"); // terminal: parked, refused
  assert.equal(harness.regDb.get(idA).state, "running"); // A untouched
});

test("2.2 no footprint → current-only judgment, byte-for-byte legacy", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  // Parked row WITHOUT an archive (rolled in before this change): wake must
  // behave exactly like the pre-projection gate — the model's current fits.
  harness.regDb.put({ ...newRegistryRow({ cellId: idA, ownerEmail: userA.email }), state: "suspended" });
  const cell = await harness.registry.ensure(userA);
  assert.equal(cell.state, "running");
});

test("2.3 sampler trouble fails open and admits", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  seedParkedWaker(harness, 900_000_000);
  harness.sampler.admission = () => { throw new Error("sampler exploded"); };
  const cell = await harness.registry.ensure(userA);
  assert.equal(cell.state, "running");
});

// ── 5.x In-flight wake reservations (add-wake-budget-admission) ─────────────
// The ledger: concurrent wakes inside one sampling window judge
// current + Σ(others' reservations) + own. A slow stub holds the first wake's
// reservation window open so a second ensure() races it deterministically.

// Numbers: current base = CACHE 50MB + GATEWAY 200MB×0.6 = 170MB; the floor
// line = 0.85 × 1536Mi ≈ 1369MB.
const FP_A = 500_000_000; // A's archive; alone: 170+500=670MB fits
const FP_B = 750_000_000; // B's archive; alone: 170+750=920MB fits
const FP_C = 1_250_000_000; // refuses on its own (170+1250=1420 > line)

test("5.1 concurrent wakes book each other: second refused BEFORE materialization, first admits", async (t) => {
  const harness = makeHarness({ stubDelayMs: 1200 });
  t.after(cleanup(harness));
  await harness.ready;
  seedParkedWaker(harness, FP_A);
  // A wakes with the slow stub — its reservation (FP_A) is registered
  // synchronously and held until its spawn settles.
  const wakeA = harness.registry.ensure(userA);
  // B arrives inside A's window: alone it fits, with A's reservation it doesn't.
  seedParked(harness, userB, FP_B);
  await assert.rejects(
    () => harness.registry.ensure(userB),
    (err) => {
      assert.equal(err.code, "memory_floor");
      assert.equal(err.memory.footprintBytes, FP_B);
      assert.equal(err.memory.inflightBytes, FP_A, "evidence carries the other wake's reservation");
      assert.equal(err.memory.projectedBytes, 170_000_000 + FP_A + FP_B);
      assert.equal(err.memory.defaultFootprintApplied, undefined);
      return true;
    },
  );
  // A was never blocked by B's refusal and materializes.
  const cellA = await wakeA;
  assert.equal(cellA.state, "running");
  // B retries after A settled: reservation released → B now admits.
  const cellB = await harness.registry.ensure(userB);
  assert.equal(cellB.state, "running");
});

test("5.2 a refused wake releases its own reservation (no residue on retry)", async (t) => {
  const harness = makeHarness({ stubDelayMs: 1200 });
  t.after(cleanup(harness));
  await harness.ready;
  seedParkedWaker(harness, FP_A);
  const wakeA = harness.registry.ensure(userA); // holds FP_A
  seedParked(harness, userB, FP_B);
  const first = await assert.rejects(
    () => harness.registry.ensure(userB),
    (err) => {
      assert.equal(err.code, "memory_floor");
      assert.equal(err.memory.projectedBytes, 170_000_000 + FP_A + FP_B);
      return true;
    },
  );
  void first;
  // B retries while A is still in flight: its first-attempt booking must have
  // been released — otherwise the projection would stack a second FP_B.
  await assert.rejects(
    () => harness.registry.ensure(userB),
    (err) => {
      assert.equal(err.code, "memory_floor");
      assert.equal(err.memory.inflightBytes, FP_A, "only A's reservation counts, B's own released");
      assert.equal(err.memory.projectedBytes, 170_000_000 + FP_A + FP_B);
      return true;
    },
  );
  await wakeA;
});

test("5.3 no archive → conservative default footprint booked; graceful park archives take over", async (t) => {
  const harness = makeHarness({ wakeDefaultFootprintMb: 1300 }); // 170+1300 > line
  t.after(cleanup(harness));
  await harness.ready;
  await assert.rejects(
    () => harness.registry.ensure(userA),
    (err) => {
      assert.equal(err.code, "memory_floor");
      assert.equal(err.memory.defaultFootprintApplied, true);
      assert.equal(err.memory.footprintBytes, undefined, "no archive — evidence must not fake one");
      assert.equal(err.memory.projectedBytes, 170_000_000 + 1300 * 1024 * 1024);
      return true;
    },
  );
  // Escape hatch: default disabled → legacy current-only judgment admits.
  const legacy = makeHarness({ wakeDefaultFootprintMb: 0 });
  t.after(cleanup(legacy));
  await legacy.ready;
  const cell = await legacy.registry.ensure(userA);
  assert.equal(cell.state, "running");
  // Takeover: with a fitting default (1000MB), the wake materializes, parks
  // gracefully, and the REAL archive — not the default — judges the next wake.
  const takeover = makeHarness({ wakeDefaultFootprintMb: 1000 }); // 170+1000 fits
  t.after(cleanup(takeover));
  await takeover.ready;
  const woken = await takeover.registry.ensure(userA);
  assert.equal(woken.state, "running");
  takeover.state.cellTotals.set(idA, 2_000_000_000); // simulate the cell's resident processes
  takeover.registry.stop(idA, "test park");
  await new Promise((r) => setTimeout(r, 300));
  const archive = takeover.regDb.get(idA).lastFootprintBytes;
  assert.ok(archive > 0 && archive < 2_000_000_000, "graceful park archived a calibrated footprint");
  // Next wake: current + REAL archive over the line → refused on the archive,
  // not the default (170 + ~1245 > line; default would have admitted).
  await assert.rejects(
    () => takeover.registry.ensure(userA),
    (err) => {
      assert.equal(err.code, "memory_floor");
      assert.equal(err.memory.footprintBytes, archive);
      assert.equal(err.memory.defaultFootprintApplied, undefined);
      assert.ok(err.memory.projectedBytes > LIMIT * (1 - FLOOR), "archive-based projection over the line");
      return true;
    },
  );
});

test("5.4 eviction re-projections count other wakes' reservations", async (t) => {
  const harness = makeHarness({ releaseHoldMs: 12_000 });
  t.after(cleanup(harness));
  await harness.ready;
  // A is HELD in flight (no release file) — its reservation stays booked.
  seedParked(harness, userA, FP_A);
  const wakeA = harness.registry.ensure(userA);
  // Resident B: released immediately, running, idle past the reap window.
  harness.state.cellTotals.set(idB, 200_000_000);
  await writeFile(path.join(harness.releaseDir, "release-" + userB.email), "go");
  await harness.registry.ensure(userB);
  harness.registry.cells.get(idB).lastTraffic = Date.now() - 7200_000;
  harness.regDb.put({ ...harness.regDb.get(idB), lastUserTrafficAt: Date.now() - 7200_000 });
  // C arrives: even after evicting B (frees its 120MB calibrated share), the
  // projection with A's reservation stays over the line → refuse, B evicted.
  const userC = { email: "third@example.com" };
  seedParked(harness, userC, 1_100_000_000);
  await assert.rejects(
    () => harness.registry.ensure(userC),
    (err) => {
      assert.equal(err.code, "memory_floor");
      assert.deepEqual(err.memory.evictedCellIds, [idB]);
      assert.equal(err.memory.inflightBytes, FP_A, "re-projection kept A's reservation");
      return true;
    },
  );
  assert.equal(harness.regDb.get(idB).state, "suspended");
  await writeFile(path.join(harness.releaseDir, "release-" + userA.email), "go");
  const cellA = await wakeA;
  assert.equal(cellA.state, "running");
});

test("5.5 fail-open and gate-disabled leave no residue", async (t) => {
  // Fail-open: B admits while the sampler is broken (its booking registered,
  // then released on settle); A is held in flight, released before C probes.
  const harness = makeHarness({ releaseHoldMs: 12_000 });
  t.after(cleanup(harness));
  await harness.ready;
  seedParked(harness, userA, FP_A);
  const wakeA = harness.registry.ensure(userA); // held
  seedParked(harness, userB, FP_B); // would refuse with A's booking — but fail-open admits
  await writeFile(path.join(harness.releaseDir, "release-" + userB.email), "go");
  harness.sampler.admission = () => { throw new Error("sampler exploded"); };
  const cellB = await harness.registry.ensure(userB);
  assert.equal(cellB.state, "running");
  // Settle A cleanly, restore the sampler, then probe with C: the evidence
  // must carry NO reservation residue — neither A's (settle-released) nor
  // B's (fail-open booking must have been released, not leaked).
  harness.sampler.admission = function (threshold, opts) {
    return evaluateAdmission({ container: this.sample().container, threshold, ...opts });
  };
  await writeFile(path.join(harness.releaseDir, "release-" + userA.email), "go");
  const cellA = await wakeA;
  assert.equal(cellA.state, "running");
  const userC = { email: "third@example.com" };
  seedParked(harness, userC, FP_C);
  await assert.rejects(
    () => harness.registry.ensure(userC),
    (err) => {
      assert.equal(err.code, "memory_floor");
      assert.equal(err.memory.inflightBytes, undefined, "fail-open path released its booking");
      return true;
    },
  );
  // Gate disabled: byte-for-byte legacy — a huge archive admits, nothing booked.
  const off = makeHarness({ floor: 0 });
  t.after(cleanup(off));
  await off.ready;
  seedParkedWaker(off, FP_C);
  const cell = await off.registry.ensure(userA);
  assert.equal(cell.state, "running");
});

// ── Footprint freshness (fix-stale-wake-footprint) ──────────────────────────
//
// An archive is evidence with no expiry: a high-water mark captured in a heavier
// era keeps refusing the wake that would re-measure it, so the cell can never
// come back to correct its own record (live 2026-11-08: 2.0GB archived against
// 755/788MB peers, headroom −28.1%, cell dark ~40min). Past the TTL the archive
// is ignored and the wake is judged on the default footprint — the same path a
// never-measured cell takes — and the next park writes a fresh number.

test("archived footprint older than the TTL does not block the wake", async (t) => {
  const harness = makeHarness({ footprintTtlMs: 60_000 });
  t.after(cleanup(harness));
  await harness.ready;
  // 1.25GB archived two hours ago — over the floor with any current use, exactly
  // the shape that went dark in production.
  harness.regDb.put({
    ...newRegistryRow({ cellId: idA, ownerEmail: userA.email }),
    state: "suspended",
    lastFootprintBytes: 1_250_000_000,
    lastFootprintAt: Date.now() - 2 * 60 * 60 * 1000,
  });
  const cell = await harness.registry.ensure(userA);
  assert.equal(cell.state, "running", "a stale archive must not lockout the wake");
});

test("archived footprint inside the TTL still governs admission", async (t) => {
  const harness = makeHarness({ footprintTtlMs: 60 * 60 * 1000 });
  t.after(cleanup(harness));
  await harness.ready;
  harness.regDb.put({
    ...newRegistryRow({ cellId: idA, ownerEmail: userA.email }),
    state: "suspended",
    lastFootprintBytes: 1_250_000_000,
    lastFootprintAt: Date.now() - 60_000, // one minute old — authoritative
  });
  await assert.rejects(() => harness.registry.ensure(userA), (err) => err.code === "memory_floor",
    "a fresh archive keeps its full weight");
});
