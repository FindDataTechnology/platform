// Unit tests — gateway durable cell registry (add-cell-lifecycle 3.1/3.3).
//
// Pins:
//   - rows round-trip with workload JSON and lifecycle fields intact
//   - fire() walks the state machine (register→bindRequested→up→down)
//   - destroyRequested keeps a tombstone that survives restarts (close+reopen)
//   - a tombstoned row stays destroyed through put() (the suppression gate)
//
// Run: node --test scripts/test-cell-registry-db.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { createCellRegistryDb } = await import("../gateway/cell-registry.js");
const NOW = Date.parse("2026-10-27T10:00:00Z");

function freshDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cellreg-")), "cells-registry.db");
  return { db: createCellRegistryDb({ file }), file };
}

test("register → bind → up → suspend round-trips with workload intact", () => {
  const { db } = freshDb();
  const r0 = db.fire("cell_a", { type: "register", now: NOW }, { policy: "on_demand" });
  assert.equal(r0.state, "unbound");
  const r1 = db.fire("cell_a", { type: "bindRequested", ownerEmail: "a@b.c", now: NOW + 1 });
  assert.equal(r1.state, "starting");
  assert.equal(r1.row.ownerEmail, "a@b.c");
  db.put({ ...r1.row, workload: { cronCount: 3, nextDueAt: NOW + 60_000 } });
  const got = db.get("cell_a");
  assert.deepEqual(
    { cronCount: got.workload.cronCount, nextDueAt: got.workload.nextDueAt },
    { cronCount: 3, nextDueAt: NOW + 60_000 },
    "advisory workload round-trips verbatim (migrate only fills missing defaults)",
  );
  const r2 = db.fire("cell_a", { type: "up", now: NOW + 2 });
  assert.equal(r2.state, "running");
  assert.equal(r2.row.lastBoundAt, NOW + 2);
  const r3 = db.fire("cell_a", { type: "down", now: NOW + 3 });
  assert.equal(r3.state, "suspended");
});

test("destroy keeps a tombstone across close+reopen; traffic beats stay refused", () => {
  const { db, file } = freshDb();
  db.fire("cell_b", { type: "register", now: NOW });
  db.fire("cell_b", { type: "bindRequested", now: NOW + 1 });
  db.fire("cell_b", { type: "up", now: NOW + 2 });
  const d = db.fire("cell_b", { type: "destroyRequested", reason: "operator:kill", now: NOW + 3 });
  assert.equal(d.state, "destroyed");
  assert.deepEqual(d.row.destroy, { reason: "operator:kill", at: NOW + 3 });
  db.close();

  const db2 = createCellRegistryDb({ file });
  const tomb = db2.get("cell_b");
  assert.equal(tomb.state, "destroyed");
  assert.equal(tomb.destroy.reason, "operator:kill");
  // The standing order is dead: lifecycle events cannot walk it back.
  const revive = db2.fire("cell_b", { type: "bindRequested", now: NOW + 4 });
  assert.ok(revive.error, "destroyed rows refuse further transitions");
  db2.close();
});

test("rows survive process-style recreation of the store (the roll scenario)", () => {
  const { db, file } = freshDb();
  db.fire("cell_c", { type: "register", now: NOW });
  db.fire("cell_c", { type: "down", now: NOW + 1 });
  db.close();
  const db2 = createCellRegistryDb({ file });
  const rows = db2.all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "suspended");
  db2.close();
});
