#!/usr/bin/env node
// ── Cell residency memory gate tests (harden-platform-memory-carrier 2.x) ───
//
// Uses the stub-cell pattern (test-cell-spawner-dedup) with a fake sampler so
// the verdict is deterministic. Covers:
//   2.1 three states — allow (zero behavior change) / refuse with the
//       four-tuple landed as durable evidence / floor=0 gate off
//   2.2 fail-open (metrics unavailable, sampler throws) + resident cells are
//       never evicted by the gate
//   2.3 refuse → headroom recovers → next request admits (no sticky refusal)
//
//   node --test scripts/test-cell-memory-gate.mjs

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCellRegistry, userIdFor } from "../gateway/spawner.js";
import { createCellRegistryDb } from "../gateway/cell-registry.js";

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

// verdict: {decision, ...} — the shape lib/proc-memory admission() returns.
function makeHarness({ verdict, floor = 0.15 } = {}) {
  let v = verdict;
  const sampler = {
    admission: (threshold) => {
      if (v instanceof Error) throw v;
      return { threshold, ...v };
    },
  };
  const harness = { sampler, setVerdict: (nv) => { v = nv; } };
  harness.ready = (async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "cell-mem-gate-")));
    const stub = path.join(root, "stub-cell.mjs");
    await writeFile(stub, STUB);
    harness.root = root;
    const regDb = createCellRegistryDb({ file: path.join(root, "cells-registry.db") });
    harness.regDb = regDb;
    harness.registry = createCellRegistry({
      dataRoot: path.join(root, "cells"),
      secret: "test-secret",
      startTimeoutMs: 15_000,
      idleReapSecs: 0,
      serverEntry: stub,
      env: { ...process.env },
      registryDb: regDb,
      procMemory: sampler,
      memoryFloor: floor,
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

const REFUSE = {
  decision: "refuse",
  usedBytes: 1_400_000_000,
  limitBytes: 1_610_612_736, // 1536Mi
  headroomPct: 0.05,
};

test("2.1 headroom above floor admits residency with zero behavior change", async () => {
  const h = makeHarness({ verdict: { decision: "allow", usedBytes: 100, limitBytes: 1000, headroomPct: 0.9 } });
  await h.ready;
  try {
    const email = "admit@gate.test";
    const cell = await h.registry.ensure({ email, groups: [] });
    assert.ok(cell.pid > 0, "cell spawned normally");
    const row = h.regDb.get(userIdFor(email));
    assert.equal(row.state, "running", "lifecycle beats unchanged");
    assert.equal(row.lastGateRefusal, null, "no refusal evidence on a clean admit");
  } finally {
    await cleanup(h)();
  }
});

test("2.1 below floor refuses with a four-tuple error and lands durable evidence", async () => {
  const h = makeHarness({ verdict: REFUSE });
  await h.ready;
  try {
    const email = "refused@gate.test";
    await assert.rejects(
      () => h.registry.ensure({ email, groups: [] }),
      (err) => {
        assert.equal(err.code, "memory_floor");
        assert.ok(err.friendly, "user-readable message carried");
        assert.equal(err.memory.usedBytes, REFUSE.usedBytes);
        assert.equal(err.memory.limitBytes, REFUSE.limitBytes);
        assert.ok(Math.abs(err.memory.headroomPct - 0.05) < 1e-9);
        assert.equal(err.memory.threshold, 0.15);
        return true;
      },
    );
    // No process spawned: no record in the in-memory registry at all.
    assert.equal(h.registry.status().filter((c) => c.userId === userIdFor(email)).length, 0);
    // Durable evidence: the row carries the refusal four-tuple; state stayed
    // out of `starting` (a refusal is evidence, not a transition).
    const row = h.regDb.get(userIdFor(email));
    assert.ok(row, "row materialized for first-contact refusal");
    assert.equal(row.state, "unbound");
    assert.equal(row.lastGateRefusal.usedBytes, REFUSE.usedBytes);
    assert.equal(row.lastGateRefusal.threshold, 0.15);
    assert.ok(row.lastGateRefusal.at > 0);
  } finally {
    await cleanup(h)();
  }
});

test("2.1 floor=0 disables the gate entirely (all admit)", async () => {
  const h = makeHarness({ verdict: REFUSE, floor: 0 });
  await h.ready;
  try {
    const cell = await h.registry.ensure({ email: "free@gate.test", groups: [] });
    assert.ok(cell.pid > 0, "refuse verdict ignored when the floor is 0");
    assert.equal(h.regDb.get(userIdFor("free@gate.test")).lastGateRefusal, null);
  } finally {
    await cleanup(h)();
  }
});

test("2.2 unreadable metrics fail open: admission with a sampler throwing", async () => {
  const h = makeHarness({ verdict: new Error("ENOENT: /proc/statm") });
  await h.ready;
  try {
    const cell = await h.registry.ensure({ email: "failopen@gate.test", groups: [] });
    assert.ok(cell.pid > 0, "sampler failure must not block business");
  } finally {
    await cleanup(h)();
  }
});

test("2.2 metrics-unavailable verdict fails open", async () => {
  const h = makeHarness({ verdict: { decision: "fail_open", reason: "cgroup_unavailable: ENOENT" } });
  await h.ready;
  try {
    const cell = await h.registry.ensure({ email: "nometrics@gate.test", groups: [] });
    assert.ok(cell.pid > 0, "unavailable metrics admit with a warning");
  } finally {
    await cleanup(h)();
  }
});

test("2.2 gate never evicts an already-resident cell", async () => {
  // Admit first, then the world degrades to hard-refuse.
  const h = makeHarness({ verdict: { decision: "allow", usedBytes: 100, limitBytes: 1000, headroomPct: 0.9 } });
  await h.ready;
  try {
    const email = "resident@gate.test";
    const first = await h.registry.ensure({ email, groups: [] });
    h.setVerdict(REFUSE);
    const second = await h.registry.ensure({ email, groups: [] });
    assert.equal(second.pid, first.pid, "running cell returned untouched by the gate");
    assert.equal(h.registry.status().filter((c) => c.userId === userIdFor(email)).length, 1);
    // Even its traffic-time registry put didn't write refusal evidence.
    assert.equal(h.regDb.get(userIdFor(email)).lastGateRefusal, null);
  } finally {
    await cleanup(h)();
  }
});

test("2.3 refusal is not sticky: recovery re-admits the next request", async () => {
  const h = makeHarness({ verdict: REFUSE });
  await h.ready;
  try {
    const email = "recover@gate.test";
    await assert.rejects(() => h.registry.ensure({ email, groups: [] }), (e) => e.code === "memory_floor");
    // Headroom recovers (a cell drained, the OOM victim exited).
    h.setVerdict({ decision: "allow", usedBytes: 100, limitBytes: 1000, headroomPct: 0.9 });
    const cell = await h.registry.ensure({ email, groups: [] });
    assert.ok(cell.pid > 0, "next residency proceeds normally");
    const row = h.regDb.get(userIdFor(email));
    assert.equal(row.state, "running");
    assert.ok(row.lastGateRefusal, "past refusal evidence stays readable");
  } finally {
    await cleanup(h)();
  }
});

test("gate unwired (no procMemory) runs byte-for-byte legacy", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cell-mem-legacy-")));
  try {
    const stub = path.join(root, "stub-cell.mjs");
    await writeFile(stub, STUB);
    const registry = createCellRegistry({
      dataRoot: path.join(root, "cells"),
      secret: "s",
      startTimeoutMs: 15_000,
      idleReapSecs: 0,
      serverEntry: stub,
      env: { ...process.env },
    });
    const cell = await registry.ensure({ email: "legacy@gate.test", groups: [] });
    assert.ok(cell.pid > 0);
    await registry.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
