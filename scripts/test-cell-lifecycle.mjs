// Unit tests — cell lifecycle vocabulary + registry (add-cell-lifecycle 0.x).
//
// Pins:
//   - the state machine only walks declared edges (executors reconcile toward
//     the registry, never the reverse)
//   - residency policy defaults to on_demand (new cells wait for real demand)
//   - wakeDue reads only persisted data: suspended + on_demand + nextDueAt past
//   - boot migration is forward-only and idempotent; the JSON ledger survives
//     a restart and never blocks boot on a corrupt file
//
// Run: node --test scripts/test-cell-lifecycle.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { CELL_STATES, RESIDENCY_POLICIES, transition, wakeDue } = await import("../lib/cell-lifecycle.js");
const { REGISTRY_SCHEMA_VERSION, newRegistryRow, migrateRegistryRow, createJsonRegistry } = await import("../lib/cell-registry.js");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cell-lifecycle-"));
const NOW = Date.parse("2026-10-27T08:00:00Z");

test("unbound → starting → running → suspending → suspended is the only walk", () => {
  const reg = transition(null, { type: "register", now: NOW });
  assert.equal(reg.state, "unbound");
  assert.equal(reg.actions.length, 0);

  const bound = transition(reg.row, { type: "bindRequested", now: NOW + 1 });
  assert.equal(bound.state, "starting");
  assert.deepEqual(bound.actions, ["spawn"]);

  const up = transition(bound.row, { type: "up", now: NOW + 2 });
  assert.equal(up.state, "running");

  const drain = transition(up.row, { type: "drainRequested", now: NOW + 3 });
  assert.equal(drain.state, "suspending");
  assert.deepEqual(drain.actions, ["drain"]);

  const down = transition(drain.row, { type: "down", now: NOW + 4 });
  assert.equal(down.state, "suspended");

  // A skipped edge is refused with an error, not silently performed
  const bad = transition(reg.row, { type: "up" });
  assert.ok(bad.error);
});

test("destroy stamps reason+time and requires the full stop sequence", () => {
  const r = transition({ state: "running", cellId: "c1" }, { type: "destroyRequested", reason: "subscription-ended", now: NOW });
  assert.equal(r.state, "destroyed");
  assert.deepEqual(r.actions, ["stop-all", "invalidate-credentials", "tombstone"]);
  assert.deepEqual(r.row.destroy, { reason: "subscription-ended", at: NOW });
});

test("new cells default to on_demand; vocabulary sets stay closed", () => {
  assert.ok(CELL_STATES.includes("unbound") && CELL_STATES.includes("destroyed"));
  assert.ok(RESIDENCY_POLICIES.includes("on_demand"));
  const row = newRegistryRow({ cellId: "cell_x", ownerEmail: "a@b.c", now: NOW });
  assert.equal(row.policy, "on_demand");
  assert.equal(row.state, "unbound");
  assert.equal(row.schemaVersion, REGISTRY_SCHEMA_VERSION);
});

test("wakeDue: only suspended on_demand rows with a past due fire", () => {
  const base = newRegistryRow({ cellId: "c", now: NOW });
  assert.equal(wakeDue({ ...base, state: "running", workload: { nextDueAt: NOW - 1 } }, NOW), false, "running is not the ring's business");
  assert.equal(wakeDue({ ...base, state: "suspended", policy: "always", workload: { nextDueAt: NOW - 1 } }, NOW), false, "always is resident, never woken");
  assert.equal(wakeDue({ ...base, state: "suspended", workload: { nextDueAt: NOW + 60_000 } }, NOW), false, "future due stays asleep");
  assert.equal(wakeDue({ ...base, state: "suspended", workload: { nextDueAt: NOW - 1 } }, NOW), true);
});

test("migration is idempotent and forward-only", () => {
  const old = { cellId: "legacy", ownerEmail: "x@y.z", state: "running", policy: "always" };
  const once = migrateRegistryRow(old);
  assert.equal(once.changed, true);
  assert.equal(once.row.schemaVersion, REGISTRY_SCHEMA_VERSION);
  assert.deepEqual(once.row.workload, { cronCount: 0, botCount: 0, fleetCount: 0, nextDueAt: null });
  assert.deepEqual(migrateRegistryRow(once.row), { row: once.row, changed: false });
});

test("json ledger persists across restarts; corrupt file never blocks boot", () => {
  const file = path.join(tmpRoot, "cells.json");
  const reg = createJsonRegistry({ file });
  reg.load();
  reg.put(newRegistryRow({ cellId: "persisted", ownerEmail: "p@q.r", now: NOW }));

  const reg2 = createJsonRegistry({ file });
  reg2.load();
  assert.equal(reg2.get("persisted").ownerEmail, "p@q.r");

  fs.writeFileSync(file, "not-json!!");
  const reg3 = createJsonRegistry({ file });
  assert.doesNotThrow(() => reg3.load());
  assert.deepEqual(reg3.all(), []);
});
