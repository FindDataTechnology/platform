// Fan-out aggregation grouping (fix-fanout-aggregation).
//
// Two defects, one seam:
//
//   D1 — a no-judge fan-out created its tasks with `initiator` but NO
//        `initiatorPreset`, so `reanchorInitiatorPersona` early-returned and the
//        summary turn was spoken by whatever the runtime last composed — the
//        LAST fan-out target's persona — instead of the post that fanned out.
//   D2 — the aggregator grouped by `initiator` alone, so a second wave from the
//        same session merged into the first wave's summary (and the group
//        inherited wave 1's initiatorPreset for all of it).
//
// This pins the grouping decision (pure) and the seam's stamping (real
// `igniteFleetEdges`). The injection itself needs a live bridge and is covered
// by the persona-park lane suite.
//
// Run: node --test scripts/test-fanout-aggregation.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanout-agg-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const engine = await import("../task-engine.js");
await engine.initTaskEngine({
  broadcast: () => {},
  runTurn: async () => ({ ok: true, text: "ok" }),
  isBusy: () => false,
});
const { aggregationKey, readyGroups } = await import("../server/delegation-aggregator.js");
const { igniteFleetEdges } = await import("../server/fleet-handoffs.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");

const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
setFleetDatabase(fleetDb);

function rec(over) {
  return { trigger: "manual", state: "done", aggregated: false, ...over };
}

test("grouping: an ignition key wins over the session, absent key falls back to it", () => {
  assert.equal(aggregationKey(rec({ initiator: "sess-1", initiatorGroup: "fanout:a:w1" })), "fanout:a:w1");
  assert.equal(aggregationKey(rec({ initiator: "sess-1" })), "sess-1", "legacy/web rows keep session grouping");
  assert.equal(aggregationKey(rec({ initiator: null, initiatorGroup: null })), null);
  assert.equal(aggregationKey(rec({})), null);
});

test("grouping: two ignitions from one session are two ready groups, not one", () => {
  const records = [
    rec({ id: "w1a", initiator: "sess-1", initiatorGroup: "fanout:x:1" }),
    rec({ id: "w1b", initiator: "sess-1", initiatorGroup: "fanout:x:1" }),
    rec({ id: "w2a", initiator: "sess-1", initiatorGroup: "fanout:x:2" }),
    rec({ id: "w2b", initiator: "sess-1", initiatorGroup: "fanout:x:2", state: "failed" }),
  ];
  const ready = readyGroups(records);
  assert.equal(ready.size, 2, "one summary per ignition wave");
  assert.equal(ready.get("fanout:x:1").length, 2);
  assert.equal(ready.get("fanout:x:2").length, 2);
});

test("grouping: a running member blocks readiness; already-summarized rows never re-arm", () => {
  const ready = readyGroups([
    rec({ id: "a", initiatorGroup: "g1" }),
    rec({ id: "b", initiatorGroup: "g1", state: "running" }),
    rec({ id: "c", initiatorGroup: "g2", aggregated: true }),
    rec({ id: "d", initiatorGroup: "g2", aggregated: true }),
  ]);
  assert.equal(ready.has("g1"), false, "b is still running");
  assert.equal(ready.has("g2"), false, "every row in g2 was already summarized");
  assert.equal(readyGroups([]).size, 0);
});

test("seam: a no-judge fan-out stamps the upstream persona AND its own group key", async () => {
  const fleet = fleetDb.createFleet({ id: "f_agg", name: "聚合舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "agg_src", fleetId: fleet.id, title: "主编", targetKind: "persona", targetId: "p-src", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "agg_w1", fleetId: fleet.id, title: "撰稿A", targetKind: "persona", targetId: "p-w1", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "agg_w2", fleetId: fleet.id, title: "撰稿B", targetKind: "persona", targetId: "p-w2", kpiSlots: [], cadence: null });
  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [
    { kind: "fanout", from: "agg_src", targets: ["agg_w1", "agg_w2"], aggregate: { kind: "all" } },
  ], constraints: { maxChainDepth: 3 } } });

  const job = {
    id: "j-agg",
    sessionId: "sess-agg",
    preset: "roster:p-src",
    origin: { fleet: { fleetId: fleet.id, memberId: "agg_src", depth: 0 } },
  };
  const wave1 = await igniteFleetEdges({ db: fleetDb, engine, job, ledgerTurn: { turnId: "t_wave1" }, out: { ok: true, text: "第一波产出" } });
  assert.equal(wave1.length, 2);
  const t1 = wave1.map(({ taskId }) => engine.getTaskRecord(taskId));
  const key1 = t1[0].initiatorGroup;
  assert.ok(key1 && key1.startsWith("fanout:"), "a per-ignition group key is stamped");
  for (const t of t1) {
    assert.equal(t.initiator, "sess-agg");
    assert.equal(t.initiatorPreset, "roster:p-src", "D1: the summary will be spoken by the upstream post");
    assert.equal(t.initiatorGroup, key1, "one wave shares one key");
  }

  // A second ignition from the SAME session must not join the first group.
  // A second ignition is a second TURN (its own ledger id) — add-fleet-ignition-idem
  // dedupes per turn, so the same job object alone would (rightly) be refused.
  const wave2 = await igniteFleetEdges({ db: fleetDb, engine, job, ledgerTurn: { turnId: "t_wave2" }, out: { ok: true, text: "第二波产出" } });
  const key2 = engine.getTaskRecord(wave2[0].taskId).initiatorGroup;
  assert.notEqual(key2, key1, "D2: a second wave is its own group");
});

test("seam: a judge wave keys the group too, and keeps the judge's persona", async () => {
  const fleet = fleetDb.createFleet({ id: "f_aggj", name: "裁决舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "aj_src", fleetId: fleet.id, title: "主编", targetKind: "persona", targetId: "p-js", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "aj_w1", fleetId: fleet.id, title: "撰稿", targetKind: "persona", targetId: "p-jw", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "aj_judge", fleetId: fleet.id, title: "评审", targetKind: "persona", targetId: "p-judge", kpiSlots: [], cadence: null });
  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [
    { kind: "fanout", from: "aj_src", targets: ["aj_w1"], aggregate: { kind: "judge", judge: "aj_judge" } },
  ], constraints: { maxChainDepth: 3 } } });

  const created = await igniteFleetEdges({
    db: fleetDb,
    engine,
    job: { id: "j-aggj", sessionId: "sess-aggj", preset: "roster:p-js", origin: { fleet: { fleetId: fleet.id, memberId: "aj_src", depth: 0 } } },
    out: { ok: true, text: "产出" },
  });
  const t = engine.getTaskRecord(created[0].taskId);
  assert.equal(t.initiator, "fleet:f_aggj:aj_judge");
  assert.equal(t.initiatorPreset, "p-judge", "the judge's persona, unchanged");
  assert.ok(t.initiatorGroup?.startsWith("fanout:"), "judge waves are grouped per ignition as well");
});

test.after(async () => {
  await engine.idle?.();
  try { fleetDb.close(); } catch { /* shared handle */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});
