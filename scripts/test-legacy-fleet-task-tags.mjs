// Legacy fleet tasks carry `origin.fleet` but no `sourceTag`
// (fix-legacy-fleet-task-tags).
//
// Production, 2026-11-09: one cell held 111 of 276 fleet-like tasks with
// `sourceTag: null` while `origin.fleet.fleetId` was set (created 2026-10-24,
// before the sourceTag field existed). Every gate asked `sourceTag?.fleetId`
// alone, so those tasks were treated as non-fleet end to end:
//   • no per-round child-session rotation (history accumulates → compaction);
//   • no fleet context injection (the patrol ran blind);
//   • no early stop and no report salvage.
// The symptom was a 600s round with `detail: "null"` and a fleet_id on its row.
//
// `buildTurnRequest` already read BOTH fields for attribution; `fleetTagOf`
// makes the rest of the runner agree with it.
//
// Run: node --test scripts/test-legacy-fleet-task-tags.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-tags-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const { fleetTagOf, roundChildSessionId, shouldSalvageReport } = await import("../server/cron-runner.js");

test("fleetTagOf: both sources, and null when neither exists", () => {
  const modern = { sourceTag: { fleetId: "f1", memberId: "m1" } };
  const legacy = { sourceTag: null, origin: { fleet: { fleetId: "f2", memberId: "m2", depth: 2 } } };
  const mixed = { sourceTag: { fleetId: "f3" }, origin: { fleet: { fleetId: "ignored", memberId: "m3" } } };
  const plain = { sourceTag: null, origin: null };

  assert.deepEqual(fleetTagOf(modern), { fleetId: "f1", memberId: "m1" });
  assert.deepEqual(fleetTagOf(legacy), { fleetId: "f2", memberId: "m2" }, "the legacy shape resolves");
  assert.deepEqual(fleetTagOf(mixed), { fleetId: "f3", memberId: "m3" }, "sourceTag wins, memberId fills from origin");
  assert.equal(fleetTagOf(plain), null);
  assert.equal(fleetTagOf(null), null);
  assert.equal(fleetTagOf(undefined), null);
});

test("legacy fleet task rotates its child session (was: accumulated forever)", () => {
  const legacy = { id: "task_1", sessionId: "task-task_1", sourceTag: null, origin: { fleet: { fleetId: "f2", memberId: "m2" } } };
  const rotated = roundChildSessionId(legacy, 1700000000000);
  assert.match(rotated, /#r1700000000000$/, "rotation applies to the legacy shape");
  // A genuinely non-fleet task keeps the plain id.
  assert.equal(roundChildSessionId({ id: "task_2", sessionId: "task-task_2", sourceTag: null }, 1700000000000), "task-task_2");
});

test("legacy fleet task is eligible for the salvage lane", async () => {
  const legacy = { sourceTag: null, origin: { fleet: { fleetId: "f2", memberId: "m2" } } };
  const detail = { contextPressure: true, reported: false, compactions: 6 };
  // Before the fix this was `Boolean(job.sourceTag?.fleetId)` → false → no lane.
  assert.equal(shouldSalvageReport(detail, { isFleet: Boolean(fleetTagOf(legacy)) }), true);
  const plain = { sourceTag: null };
  assert.equal(shouldSalvageReport(detail, { isFleet: Boolean(fleetTagOf(plain)) }), false, "a true non-fleet task stays out");
});

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});
