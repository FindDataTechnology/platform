#!/usr/bin/env node
// ── /api/monitoring/memory face tests (harden-platform-memory-carrier 1.2) ──
//
// Pins the three-layer response shape (container → cells → processes) and the
// admin/owner scoping, against a fake sampler — the lib/proc-memory scan
// itself is covered by test-proc-memory.mjs:
//
//   node --test scripts/test-memory-face.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryFace, defaultAdmissionThreshold } from "../gateway/memory-face.js";

function fakeSample() {
  return {
    available: true,
    sampledAt: 1700000000000,
    container: { available: true, usedBytes: 900 * 1024 * 1024, limitBytes: 1536 * 1024 * 1024 },
    cells: [
      {
        cellId: "aaaaaaaaaaaaaaaa",
        totalBytes: 220 * 1024 * 1024,
        satellites: { count: 1, totalBytes: 20 * 1024 * 1024 },
        processes: [
          { pid: 11, name: "server.js", rssBytes: 200 * 1024 * 1024, role: "cell-server", cellId: "aaaaaaaaaaaaaaaa" },
          { pid: 12, name: "delegation-mcp.js", rssBytes: 20 * 1024 * 1024, role: "mcp-satellite", cellId: "aaaaaaaaaaaaaaaa" },
        ],
      },
      {
        cellId: "bbbbbbbbbbbbbbbb",
        totalBytes: 130 * 1024 * 1024,
        satellites: { count: 0, totalBytes: 0 },
        processes: [{ pid: 21, name: "server.js", rssBytes: 130 * 1024 * 1024, role: "cell-server", cellId: "bbbbbbbbbbbbbbbb" }],
      },
    ],
    gateway: { totalBytes: 100 * 1024 * 1024, processes: [{ pid: 1, name: "index.js", rssBytes: 100 * 1024 * 1024, role: "gateway", cellId: null }] },
    ungrouped: { totalBytes: 5 * 1024 * 1024, processes: [{ pid: 2, name: "job.js", rssBytes: 5 * 1024 * 1024, role: "ungrouped", cellId: null }] },
    buckets: { "cell-server": 2, "dsh-runtime": 0, "mcp-satellite": 1, gateway: 1, ungrouped: 1 },
  };
}

function fakeRegistry() {
  return {
    all: () => [
      { cellId: "aaaaaaaaaaaaaaaa", ownerEmail: "me@test" },
      { cellId: "bbbbbbbbbbbbbbbb", ownerEmail: "other@test" },
    ],
  };
}

test("three layers in one response: container headroom → cells → processes", () => {
  const face = memoryFace({ sample: fakeSample(), registryDb: fakeRegistry(), ownerEmail: "me@test", isAdmin: true, threshold: 0.15 });
  assert.ok(face.available);
  // container layer: usage/limit/headroom + the gate's threshold
  assert.equal(face.container.usedBytes, 900 * 1024 * 1024);
  assert.equal(face.container.limitBytes, 1536 * 1024 * 1024);
  assert.ok(Math.abs(face.container.headroomPct - (1 - 900 / 1536)) < 1e-9);
  assert.equal(face.container.threshold, 0.15);
  // cell layer: RSS 降序 + process rows readable
  assert.ok(face.cells[0].totalBytes >= face.cells[1].totalBytes);
  assert.equal(face.cells[0].cellId, "aaaaaaaaaaaaaaaa");
  assert.deepEqual(face.cells[0].processes.map((p) => p.role), ["cell-server", "mcp-satellite"]);
  // The satellite summary rides the cell row (share-mcp-satellites 4.1): the
  // payoff of "one satellite set per cell" has to be readable here.
  assert.deepEqual(face.cells[0].satellites, { count: 1, totalBytes: 20 * 1024 * 1024 });
  // gateway + ungrouped remainder + buckets + sampledAt
  assert.equal(face.gateway.processes.length, 1);
  assert.equal(face.ungrouped.totalBytes, 5 * 1024 * 1024);
  assert.equal(face.buckets["mcp-satellite"], 1);
  assert.equal(face.sampledAt, 1700000000000);
});

test("owner scoping: non-admin sees own cells only, others' rows reduced to totals", () => {
  const face = memoryFace({ sample: fakeSample(), registryDb: fakeRegistry(), ownerEmail: "me@test", isAdmin: false, threshold: 0.15 });
  assert.equal(face.cells.length, 1, "only my cell");
  assert.equal(face.cells[0].cellId, "aaaaaaaaaaaaaaaa");
  assert.equal(face.cells[0].ownerEmail, "me@test");
  assert.equal(face.cells[0].processes.length, 2, "my processes stay readable");
  // Scoping must not strip the satellite summary: an owner asking "why is my
  // cell heavy" gets the same answer an admin does.
  assert.deepEqual(face.cells[0].satellites, { count: 1, totalBytes: 20 * 1024 * 1024 });
  // gateway/ungrouped: totals only — another user's process list never leaks
  assert.deepEqual(Object.keys(face.gateway), ["totalBytes"]);
  assert.deepEqual(Object.keys(face.ungrouped), ["totalBytes"]);
});

test("unavailable metrics degrade honestly, not as an error", () => {
  const face = memoryFace({ sample: { available: false, reason: "proc_unavailable: ENOENT" }, threshold: 0.15 });
  assert.equal(face.available, false);
  assert.match(face.reason, /proc_unavailable/);
});

test("container unreadable but scan fine: container carries the reason", () => {
  const s = fakeSample();
  s.container = { available: false, reason: "cgroup_unavailable: ENOENT" };
  const face = memoryFace({ sample: s, isAdmin: true });
  assert.ok(face.available);
  assert.equal(face.container.available, false);
  assert.match(face.container.reason, /cgroup_unavailable/);
  assert.equal(face.container.headroomPct, undefined, "no headroom without a limit");
});

test("threshold default comes from env, malformed env falls back to 0.15", () => {
  assert.equal(defaultAdmissionThreshold({ CELL_MEMORY_ADMISSION_FLOOR: "0.2" }), 0.2);
  assert.equal(defaultAdmissionThreshold({}), 0.15);
  assert.equal(defaultAdmissionThreshold({ CELL_MEMORY_ADMISSION_FLOOR: "NaN-ish" }), 0.15);
});
