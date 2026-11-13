#!/usr/bin/env node
// ── Fleet scheduler tests (add-fleet-scheduler) ────────────────────────────
//
// The control loop's decisions against a fake observer board and registry:
// stale runners lose their entries to the healthiest target (port-collision
// aware, untagged entries included when the DEFAULT runner dies, hysteresis
// on recovery), placement picks the emptiest healthy machine, and there is
// never a move without a healthy target with room.
//
//   node --test scripts/test-fleet-scheduler.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { createFleetScheduler } = await import("../gateway/fleet-scheduler.js");
const { agentPortFor } = await import("../lib/agent-serving.js");

const NOW = 1_800_000_000_000;

function fakeRegistry(entries) {
  const puts = [];
  return {
    puts,
    listAgents: async () => ({ agents: entries }),
    putAgent: async (path, body) => {
      puts.push({ path, body });
      const i = entries.findIndex((e) => e.path === path);
      if (i >= 0) entries[i] = body;
      return { ok: true };
    },
  };
}

const ROWS = [
  { id: "cheap-1", baseUrl: "http://100.64.0.11", portBase: 8791, portSpan: 32, createdAt: NOW - 86_400_000 },
  { id: "runner-b", baseUrl: "http://100.64.0.13", portBase: 8851, portSpan: 32, createdAt: NOW - 86_400_000 },
  { id: "runner-c", baseUrl: "http://100.64.0.14", portBase: 8891, portSpan: 32, createdAt: NOW - 86_400_000 },
];

const mk = (over = {}) => ({
  runners: {
    "cheap-1": { seen_at: NOW, children: 2, budget_mb: 400, budget_mb_limit: 768 },
    "runner-b": { seen_at: NOW, children: 1, budget_mb: 150, budget_mb_limit: 768 },
    "runner-c": { seen_at: NOW, children: 0, budget_mb: 0, budget_mb_limit: 768 },
    ...over,
  },
});

const harness = ({ board, entries, rows = ROWS }) => {
  const reg = fakeRegistry(entries);
  const sched = createFleetScheduler({
    registry: reg,
    boardFetch: async () => board,
    fleetRows: () => rows,
    log: { log() {}, warn() {} },
    now: () => NOW,
  });
  return { sched, reg, entries };
};

test("failover: a stale runner's entry re-points to the emptiest healthy runner", async () => {
  const entries = [{ path: "/packs/p1/a", name: "A", provider: "paas-pack", metadata: { packId: "p1", runner_id: "runner-b" } }];
  const board = mk({ "runner-b": { seen_at: NOW - 300_000, children: 1, budget_mb: 150, budget_mb_limit: 768 } });
  const { sched, reg } = harness({ board, entries });
  const out = await sched.tick();
  assert.equal(out.moved, 1);
  const body = reg.puts[0].body;
  assert.equal(body.provider.organization, "paas-pack", "the GET display string is rebuilt into the PUT dict shape (both fields required)");
  assert.equal(typeof body.provider.url, "string");
  assert.equal(body.metadata.runner_id, "runner-c", "most headroom wins");
  assert.equal(body.url, `http://100.64.0.14:${agentPortFor("/packs/p1/a", { base: 8891, span: 32 })}`, "URL = target base + collision-aware port");
  assert.equal("port_override" in body.metadata, false, "no displacement on an empty slice");
});

test("failover: the DEFAULT runner's stale pass takes its untagged entries too", async () => {
  const entries = [
    { path: "/packs/p1/a", metadata: { packId: "p1", runner_id: "cheap-1" } },
    { path: "/packs/p2/b", metadata: { packId: "p2" } }, // untagged = default runner's
    { path: "/packs/p3/c", metadata: { packId: "p3", runner_id: "runner-b" } }, // a healthy runner's — untouched
  ];
  const board = mk({ "cheap-1": { seen_at: NOW - 300_000, children: 2, budget_mb: 400, budget_mb_limit: 768 } });
  const { sched, reg, entries: live } = harness({ board, entries });
  const out = await sched.tick();
  assert.equal(out.moved, 2, "tagged + untagged default entries move");
  const moved = reg.puts.map((p) => p.path).sort();
  assert.deepEqual(moved, ["/packs/p1/a", "/packs/p2/b"]);
  for (const p of reg.puts) assert.equal(p.body.metadata.runner_id, "runner-c");
  const untouched = live.find((e) => e.path === "/packs/p3/c");
  assert.equal(untouched.metadata.runner_id, "runner-b", "healthy runners' entries never move");
});

test("failover: a displacement on the target stamps port_override and the URL matches it", async () => {
  const hashPort = agentPortFor("/packs/p1/a", { base: 8891, span: 32 });
  const entries = [
    { path: "/packs/p1/a", metadata: { packId: "p1", runner_id: "runner-b" } },
    { path: "/packs/p2/squatter", metadata: { packId: "p2", runner_id: "runner-c", port_override: hashPort } },
  ];
  const board = mk({
    "runner-b": { seen_at: NOW - 300_000, children: 1, budget_mb: 150, budget_mb_limit: 768 },
    "runner-c": { seen_at: NOW - 10_000, children: 1, budget_mb: 96, budget_mb_limit: 768 },
  });
  const { sched, reg } = harness({ board, entries });
  await sched.tick();
  const body = reg.puts[0].body;
  assert.equal(body.metadata.runner_id, "runner-c");
  assert.equal(body.metadata.port_override !== hashPort, true, "displaced off the squatted slot");
  assert.equal(body.url, `http://100.64.0.14:${body.metadata.port_override}`);
});

test("failover: no healthy target ⇒ no writes; span-full targets fall through to the next runner", async () => {
  // All runners stale → nothing happens.
  {
    const entries = [{ path: "/packs/p1/a", metadata: { packId: "p1", runner_id: "runner-b" } }];
    const board = mk({
      "cheap-1": { seen_at: NOW - 300_000, children: 2, budget_mb: 400, budget_mb_limit: 768 },
      "runner-b": { seen_at: NOW - 300_000, children: 1, budget_mb: 150, budget_mb_limit: 768 },
      "runner-c": { seen_at: NOW - 300_000, children: 0, budget_mb: 0, budget_mb_limit: 768 },
    });
    const { sched, reg } = harness({ board, entries });
    const out = await sched.tick();
    assert.equal(out.moved, 0);
    assert.equal(reg.puts.length, 0);
  }
  // The emptiest target's span is full (32 squatters) → the entry lands on the next one.
  {
    const entries = [{ path: "/packs/p1/a", metadata: { packId: "p1", runner_id: "runner-b" } }];
    for (let i = 0; i < 32; i += 1) {
      entries.push({ path: `/packs/full-${i}/a`, metadata: { packId: "full", runner_id: "runner-c", port_override: 8891 + i } });
    }
    const board = mk({ "runner-b": { seen_at: NOW - 300_000, children: 1, budget_mb: 150, budget_mb_limit: 768 } });
    const { sched, reg } = harness({ board, entries });
    const out = await sched.tick();
    assert.equal(out.moved, 1);
    assert.equal(reg.puts[0].body.metadata.runner_id, "cheap-1", "fell through the full runner-c to cheap-1");
  }
});

test("failover: hysteresis — a recovered runner never reclaims; its heartbeat only re-opens placement", async () => {
  const entries = [{ path: "/packs/p1/a", metadata: { packId: "p1", runner_id: "runner-c" } }]; // already failed over
  const board = mk({ "runner-b": { seen_at: NOW, children: 0, budget_mb: 0, budget_mb_limit: 768 } }); // recovered
  const { sched, reg } = harness({ board, entries });
  const out = await sched.tick();
  assert.equal(out.moved, 0);
  assert.equal(reg.puts.length, 0, "nothing stale ⇒ nothing moves");
  assert.equal(sched.stale(board).length, 0);
  assert.equal(sched.healthy(board).map((h) => h.id).includes("runner-b"), true);
});

test("placement: pickPlacement orders by headroom then children; the exclude set works", async () => {
  const board = mk();
  const { sched } = harness({ board, entries: [] });
  assert.equal(sched.pickPlacement(board).id, "runner-c", "emptiest wins");
  assert.equal(sched.pickPlacement(board, { exclude: ["runner-c"] }).id, "runner-b");
  assert.equal(sched.pickPlacement(board, { exclude: ["runner-c", "runner-b", "cheap-1"] }), null);
  // Headroom dominates children counts.
  const tight = mk({
    "runner-c": { seen_at: NOW, children: 0, budget_mb: 700, budget_mb_limit: 768 },
    "runner-b": { seen_at: NOW, children: 3, budget_mb: 100, budget_mb_limit: 768 },
  });
  assert.equal(sched.pickPlacement(tight).id, "runner-b", "more headroom beats fewer children");
});

test("failover: board or registry outage skips the pass (never a blind move)", async () => {
  const entries = [{ path: "/packs/p1/a", metadata: { packId: "p1", runner_id: "runner-b" } }];
  {
    const reg = fakeRegistry(entries);
    const sched = createFleetScheduler({ registry: reg, boardFetch: async () => { throw new Error("observer down"); }, fleetRows: () => ROWS, log: { log() {}, warn() {} }, now: () => NOW });
    const out = await sched.tick();
    assert.equal(out.moved, 0);
    assert.equal(reg.puts.length, 0);
  }
  {
    const reg = { listAgents: async () => { throw new Error("registry down"); }, putAgent: async () => { throw new Error("never"); } };
    const board = mk({ "runner-b": { seen_at: NOW - 300_000, children: 1, budget_mb: 150, budget_mb_limit: 768 } });
    const sched = createFleetScheduler({ registry: reg, boardFetch: async () => board, fleetRows: () => ROWS, log: { log() {}, warn() {} }, now: () => NOW });
    const out = await sched.tick();
    assert.equal(out.moved, 0);
  }
});


test("failover: a runner PRUNED from the board entirely still loses its entries (orphan detection)", async () => {
  // The observer drops long-dead runners from the board — staleness alone
  // would never fire (live drill finding). Absent + past the provisioning
  // grace = orphaned.
  const entries = [
    { path: "/packs/p1/a", name: "A", provider: "paas-pack", version: 1, metadata: { packId: "p1", runner_id: "runner-b" } },
  ];
  const board = { runners: {
    "cheap-1": { seen_at: NOW, children: 2, budget_mb: 400, budget_mb_limit: 768 },
    "runner-c": { seen_at: NOW, children: 0, budget_mb: 0, budget_mb_limit: 768 },
    // runner-b NOT on the board at all
  } };
  const { sched, reg } = harness({ board, entries });
  const out = await sched.tick();
  assert.equal(out.moved, 1, "the pruned runner's orphaned entry still fails over");
  assert.equal(reg.puts[0].body.metadata.runner_id, "runner-c");
});

test("failover: a brand-new fleet row keeps its pre-assigned entries for the grace window", async () => {
  const entries = [
    { path: "/packs/p1/a", name: "A", provider: "paas-pack", version: 1, metadata: { packId: "p1", runner_id: "runner-d" } },
  ];
  const rows = [...ROWS, { id: "runner-d", baseUrl: "http://100.64.0.15", portBase: 8931, portSpan: 32, createdAt: NOW - 60_000 }];
  const board = { runners: {
    "cheap-1": { seen_at: NOW, children: 2, budget_mb: 400, budget_mb_limit: 768 },
    "runner-c": { seen_at: NOW, children: 0, budget_mb: 0, budget_mb_limit: 768 },
  } };
  const reg = fakeRegistry(entries);
  const sched = createFleetScheduler({ registry: reg, boardFetch: async () => board, fleetRows: () => rows, log: { log() {}, warn() {} }, now: () => NOW });
  const out = await sched.tick();
  assert.equal(out.moved, 0, "provisioning runner (row < grace) is not treated as dead");
  assert.equal(reg.puts.length, 0);
});

// ── Desktop seat invisibility (add-desktop-fleet-runner ③) ─────────────────
// A desktop- prefixed seat (or a self-reported desktop row) is monitoring-
// only: its staleness never fails its entries over, its board-pruned absence
// never orphans them, and it is never picked as a placement target.

test("desktop: a STALE desktop seat keeps its entries (closed app ≠ dead runner)", async () => {
  const entries = [
    { path: "/packs/p1/a", name: "A", provider: "paas-pack", version: 1, metadata: { packId: "p1", runner_id: "desktop-abcd1234" } },
  ];
  const board = { runners: {
    "cheap-1": { seen_at: NOW, children: 0, budget_mb: 0, budget_mb_limit: 768 },
    // The seat's heartbeat went stale ages ago.
    "desktop-abcd1234": { seen_at: NOW - 3_600_000, children: 1, budget_mb: 100, budget_mb_limit: 2048 },
  } };
  const { sched, reg } = harness({ board, entries });
  const out = await sched.tick();
  assert.equal(out.moved, 0, "desktop entries are never re-pointed");
  assert.equal(reg.puts.length, 0);
});

test("desktop: a PRUNED desktop seat's entries wait (never orphaned)", async () => {
  const entries = [
    { path: "/packs/p1/a", name: "A", provider: "paas-pack", version: 1, metadata: { packId: "p1", runner_id: "desktop-abcd1234" } },
  ];
  const board = { runners: {
    "cheap-1": { seen_at: NOW, children: 0, budget_mb: 0, budget_mb_limit: 768 },
    // The seat is entirely absent from the board.
  } };
  // The seat carries a fleet row (a future device-management plane may
  // register one) well past the grace window — the entries still wait.
  const rows = [...ROWS, { id: "desktop-abcd1234", baseUrl: "http://192.168.1.9", portBase: 8791, portSpan: 32, createdAt: NOW - 86_400_000 }];
  const reg = fakeRegistry(entries);
  const sched = createFleetScheduler({ registry: reg, boardFetch: async () => board, fleetRows: () => rows, log: { log() {}, warn() {} }, now: () => NOW });
  const out = await sched.tick();
  assert.equal(out.moved, 0, "desktop entries are never orphan-reaped");
  assert.equal(reg.puts.length, 0);
});

test("desktop: a self-reported desktop row is excluded from placement targets", async () => {
  const board = { runners: {
    "cheap-1": { seen_at: NOW, children: 2, budget_mb: 400, budget_mb_limit: 768 },
    // NOT desktop- prefixed, but its runner_stats self-reports desktop.
    "laptop-seat": { seen_at: NOW, children: 0, budget_mb: 0, budget_mb_limit: 4096, desktop: true },
  } };
  const sched = createFleetScheduler({ registry: fakeRegistry([]), boardFetch: async () => board, fleetRows: () => ROWS, log: { log() {}, warn() {} }, now: () => NOW });
  const pick = sched.pickPlacement(board);
  assert.equal(pick.id, "cheap-1", "the desktop self-report keeps the seat out of placement even with more headroom");
  assert.deepEqual(sched.healthy(board).map((r) => r.id), ["cheap-1"]);
});
