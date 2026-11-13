// add-pack-memory-declaration 4.2: releasing a pack root's policy when a team leaves.
//
// The row is keyed by PACK (`d-<pack>`), and every team landed from one pack
// shares it. So the decision cannot be "a team was archived → clear": that would
// let one owner's archive switch off another owner's team on the same pack. The
// rule under test is "clear only when this was the LAST live team on that pack",
// which is what the storage's granularity actually supports.
//
//   node --test scripts/test-pack-memory-release.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { reconcileFleet } from "../server/fleet-reconcile.js";

function store(states) {
  const fleets = states.map(([id, state, packId]) => ({ id, state, sourceTemplate: packId ? { packId } : null }));
  return {
    getFleet: (id) => fleets.find((f) => f.id === id),
    listMembers: () => [],
    listFleets: () => fleets,
  };
}

const cron = {
  listJobs: () => [],
  addJob: async () => ({}),
  updateJob: async () => {},
  pauseJob: async () => {},
  resumeJob: async () => {},
  removeJob: async () => {},
};

function spyRelease() {
  const seen = [];
  const fn = async (args) => {
    seen.push(args);
    return { ok: true, action: "cleared", rootKey: `d-${args.packId}` };
  };
  return { seen, fn };
}

const ALIVE = () => ({ alive: true });

test("archiving the LAST team on a pack releases its policy root", async () => {
  const { seen, fn } = spyRelease();
  const db = store([["f1", "archived", "packA"], ["f2", "active", "packB"]]);
  const out = await reconcileFleet({ fleetId: "f1", db, cronApi: cron, resolveTarget: ALIVE, releaseMemoryPolicy: fn });
  assert.deepEqual(seen, [{ packId: "packA", liveFleets: 0 }]);
  assert.equal(out.memoryPolicy.action, "cleared");
});

test("a sibling team on the same pack keeps the root — one owner cannot switch off another", async () => {
  const { seen, fn } = spyRelease();
  const db = store([["f1", "archived", "packA"], ["f3", "active", "packA"]]);
  const out = await reconcileFleet({ fleetId: "f1", db, cronApi: cron, resolveTarget: ALIVE, releaseMemoryPolicy: fn });
  assert.deepEqual(seen, [], "still one live team: the row must survive untouched");
  assert.equal(out.memoryPolicy, undefined);
});

test("nothing is released for a fleet that is not archived, or has no pack origin", async () => {
  {
    const { seen, fn } = spyRelease();
    await reconcileFleet({ fleetId: "f1", db: store([["f1", "active", "packA"]]), cronApi: cron, resolveTarget: ALIVE, releaseMemoryPolicy: fn });
    assert.deepEqual(seen, [], "an active team releases nothing");
  }
  {
    const { seen, fn } = spyRelease();
    await reconcileFleet({ fleetId: "f9", db: store([["f9", "archived", null]]), cronApi: cron, resolveTarget: ALIVE, releaseMemoryPolicy: fn });
    assert.deepEqual(seen, [], "a hand-built fleet has no pack root to release");
  }
});

test("a memory failure never stops the archive from converging", async () => {
  const db = store([["f1", "archived", "packA"]]);
  const out = await reconcileFleet({
    fleetId: "f1",
    db,
    cronApi: cron,
    resolveTarget: ALIVE,
    releaseMemoryPolicy: async () => {
      throw new Error("memory unreachable");
    },
  });
  assert.equal(out.memoryPolicy.ok, false);
  assert.equal(out.memoryPolicy.action, "failed");
  assert.match(out.memoryPolicy.reason, /unreachable/);
  // The reconcile itself still completed — archive is not blocked by memory.
  assert.deepEqual(out.removed, []);
});
