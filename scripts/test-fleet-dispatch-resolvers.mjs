#!/usr/bin/env node
// ── Fleet dispatch entries actually reach their resolver ─────────────────────
//
// Companion to scripts/check-fleet-dispatch-resolvers.mjs:
//
//   check-fleet-dispatch-resolvers.mjs  reads the CALL SITE (server.js) and
//                                       proves the wiring names a resolver.
//   this file                           drives the SEAMS with the same deps
//                                       shape and proves the resolver is
//                                       reachable at runtime, under the RIGHT
//                                       key.
//
// Why both: the 2026-11-17 defect was a missing argument at the call site, and
// the 2026-11-19 one was a correct-looking argument under the wrong key
// (`resolveFleetTarget` where the lane destructures `resolveTarget`). A scanner
// alone would have passed the second one, because the text DID mention a
// resolver. So the second defect needs a runtime assertion, not a text one.
//
// Run: node --test scripts/test-fleet-dispatch-resolvers.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { triggerFleetEventWake } from "../server/fleet-event-wake.js";
import { igniteFleetEdges } from "../server/fleet-handoffs.js";
import { checkSource, selfTest, SEAMS, RESOLVER_PARAM } from "./check-fleet-dispatch-resolvers.mjs";

const personaMember = { id: "m2", fleetId: "f1", targetKind: "persona", targetId: "p2", title: "Writer" };

function fakeFleetDb(edgeKind) {
  return {
    listFleets: () => [
      {
        id: "f1",
        state: "active",
        orchestration: {
          edges: [{ kind: edgeKind, from: edgeKind === "event" ? "bot:b1" : "m1", to: "m2" }],
        },
      },
    ],
    getFleet: () => ({
      id: "f1",
      orchestration: { edges: [{ kind: edgeKind, from: edgeKind === "event" ? "bot:b1" : "m1", to: "m2" }] },
    }),
    getMember: (id) => (id === "m2" ? personaMember : id === "m1" ? { ...personaMember, id: "m1" } : null),
  };
}

function countingEngine() {
  const created = [];
  return {
    created,
    createManualTask: (spec) => {
      created.push(spec);
      return { id: `task-${created.length}`, ...spec };
    },
  };
}

// ── Event wake: the deps key is the whole bug ────────────────────────────────

test("event wake refuses deps under the wrong key", async () => {
  process.env.EVENT_WAKE_COALESCE_MS = "0"; // bypass the coalescing window
  // This is exactly what server.js passed before the fix.
  assert.throws(
    () => triggerFleetEventWake({ db: fakeFleetDb("event"), engine: countingEngine(), roster: (i) => i, resolveFleetTarget: () => ({ alive: true }) }, "b1", {}),
    /needs resolveTarget/,
  );
});

test("event wake reaches the resolver under the right key", async () => {
  process.env.EVENT_WAKE_COALESCE_MS = "0";
  const asked = [];
  const engine = countingEngine();
  triggerFleetEventWake(
    {
      db: fakeFleetDb("event"),
      engine,
      roster: (i) => i,
      resolveTarget: (target) => {
        asked.push(target);
        return { alive: true, label: "live", clusterName: null };
      },
    },
    "b1",
    {},
  );
  assert.deepEqual(
    asked,
    [{ targetKind: "persona", targetId: "p2" }],
    "the lane must ask the resolver about the EDGE TARGET, in the shape fleet-target-runnable passes",
  );
  assert.equal(engine.created.length, 1, "a runnable target gets a turn");
});

// ── Handoff: same shape for the other seam ───────────────────────────────────

test("handoff refuses to run without a resolver", async () => {
  await assert.rejects(
    () =>
      igniteFleetEdges({
        db: fakeFleetDb("handoff"),
        engine: countingEngine(),
        job: { id: "j1", origin: { fleet: { fleetId: "f1", memberId: "m1", depth: 0 } } },
        out: { ok: true, text: "done" },
      }),
    /needs resolveTarget/,
  );
});

test("handoff reaches the resolver and ignites the downstream post", async () => {
  let resolverCalls = 0;
  const engine = countingEngine();
  const created = await igniteFleetEdges({
    db: fakeFleetDb("handoff"),
    engine,
    job: { id: "j1", origin: { fleet: { fleetId: "f1", memberId: "m1", depth: 0 } } },
    out: { ok: true, text: "done" },
    resolveTarget: (member) => {
      resolverCalls++;
      assert.equal(member.targetKind, "persona");
      return { alive: true, label: "live", clusterName: null };
    },
  });
  assert.equal(resolverCalls, 1);
  assert.ok(created && created.length >= 1, "the downstream post gets a manual turn");
  assert.equal(engine.created.length, created.length);
});

// ── The scanner's own health ────────────────────────────────────────────────────

test("the call-site scanner's self-test is green", () => {
  const st = selfTest();
  const failures = Object.entries(st).filter(([, ok]) => !ok).map(([k]) => k);
  assert.deepEqual(failures, [], "a broken scanner would report both findings or none");
});

test("the scanner sees every dispatch seam", () => {
  assert.deepEqual([...SEAMS].sort(), ["deliverFleetEventWake", "igniteFleetEdges", "triggerFleetEventWake"]);
  assert.equal(RESOLVER_PARAM, "resolveTarget");
});

test("the scanner is red on a missing resolver and green on the key it requires", () => {
  const missing = checkSource("igniteFleetEdges({ db });", { file: "t.js" });
  const wrongKey = checkSource("triggerFleetEventWake({ db, resolveFleetTarget });", { file: "t.js" });
  const right = checkSource("igniteFleetEdges({ db, resolveTarget: r });", { file: "t.js" });
  assert.equal(missing.length, 1);
  assert.equal(wrongKey.length, 1, "the wrong key must be red — that was defect #2");
  assert.equal(right.length, 0);
});
