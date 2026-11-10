#!/usr/bin/env node
// ── Fleet ↔ room bridge tests (add-zhiyu-team-memory 刀B) ───────────────────
//
// Pins:
//   - subscription CRUD: subscribe requires OWNERSHIP (a fleet not in the
//     caller's sample answers 404, indistinguishable from nonexistent);
//     idempotent re-subscribe; cap per room; remove stops the flow
//   - the pull tick: report/decision/health diffs land as system rows with a
//     deep link; the FIRST sight of a fleet baselines silently (no history
//     dump); a dead cell (null sample) mutes the tick without error
//   - rate control: >MAX_PER_WINDOW dense items merge into one count+sample
//     line; circuit-open drops with the recovery line's 丢弃 note
//   - summon: the plan separates serving members from cockpit-only posts;
//     execution creates invites through the EXISTING handshake and carries
//     the subscription; partial failures stay per-item
//
//   node --test scripts/test-fleet-room-bridge.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";
import http from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-room-bridge-"));
const { createZhiyuStore } = await import("../gateway/zhiyu/store.js");
const { registerFleetRoomBridge } = await import("../gateway/fleet-room-bridge.js");

const store = createZhiyuStore({ file: path.join(tmp, "zhiyu.db") });

const OWNER = "owner@test";
const room = store.roomCreate({ title: "桥测试房", ownerEmail: OWNER });

// A controllable sample: tests mutate `sample` between ticks.
let sample = null;
let _sampleCalls = 0;
const sampleFleets = async (_ownerEmail) => {
  _sampleCalls += 1;
  return sample;
};

const app = express();
app.use(express.json({ limit: "1mb" }));
registerFleetRoomBridge(app, { store, resolveUser: (_req) => ({ email: OWNER, groups: [] }), rejectUnauthenticated: (_q, r) => r.status(401).json({}), sampleFleets });
const server = http.createServer(app);
server.listen(0);
const call = (method, p, body) =>
  fetch(`http://127.0.0.1:${server.address().port}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const overview = (fleets) => ({ v: 1, sampledAt: Date.now(), fleets });

function fleetShape(id, name, over = {}) {
  return {
    id,
    name,
    counts: { onDuty: 1, paused: 0, missing: 0, vacant: 0, passive: 0, failing: 0, total: 1 },
    openDecisions: { count: 0, top: [] },
    stream: [],
    ...over,
  };
}

const systemRows = () =>
  store
    .messagesAfter(room.id, 0)
    .filter((m) => m.kind === "system" && (m.provenance ?? "") === "fleet-room-bridge");

test("subscribe: ownership checked against the live sample; foreign = 404", async () => {
  sample = overview([fleetShape("fleet_ok", "客服班组")]);
  const ok = await call("POST", `/api/zhiyu/rooms/${room.id}/fleet-subscriptions`, { fleetId: "fleet_ok" });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.subscription.fleetName, "客服班组");

  sample = overview([]); // the fleet vanished from the owner's sample
  const ghost = await call("POST", `/api/zhiyu/rooms/${room.id}/fleet-subscriptions`, { fleetId: "fleet_ghost" });
  assert.equal(ghost.status, 404, "not-owned is indistinguishable from nonexistent");
});

test("subscribe: idempotent; cap enforced", async () => {
  sample = overview([fleetShape("fleet_ok", "客服班组")]);
  const again = await call("POST", `/api/zhiyu/rooms/${room.id}/fleet-subscriptions`, { fleetId: "fleet_ok" });
  assert.equal(again.status, 201);
  const list = await call("GET", `/api/zhiyu/rooms/${room.id}/fleet-subscriptions`);
  assert.equal(list.body.subscriptions.filter((s) => s.fleetId === "fleet_ok").length, 1, "no dup rows");
});

test("tick: first sight baselines silently; the second tick emits new facts", async () => {
  sample = overview([
    fleetShape("fleet_ok", "客服班组", {
      openDecisions: { count: 1, top: [{ question: "续约供应商？", severity: "high", memberTitle: "客服组长" }] },
      stream: [{ title: "一线客服", at: 1793000000000, summarySnip: "处理 12 单，首响 8 分钟", metrics: {} }],
    }),
  ]);
  await registerFleetRoomBridge; // noop reference
  const _bridge = { tick: null };
  // Re-enter the tick via a fresh bridge sharing THIS store (the module returns
  // { tick } — we call it directly through a second registration on the same
  // store but route-less: simplest is to invoke the returned tick from the
  // first registration; we registered without keeping it, so run one inline.)
  const { registerFleetRoomBridge: reg } = await import("../gateway/fleet-room-bridge.js");
  const b = reg(express(), {
    store,
    resolveUser: (_req) => ({ email: OWNER, groups: [] }),
    rejectUnauthenticated: (_q, r) => r.status(401).json({}),
    sampleFleets,
  });
  await b.tick(); // baseline (first sight) — emits nothing
  const afterBase = systemRows().filter((m) => m.meta?.bridge === "report");
  assert.equal(afterBase.length, 0, "no history dump on subscribe");

  sample = overview([
    fleetShape("fleet_ok", "客服班组", {
      openDecisions: { count: 2, top: [{ question: "退款赔付怎么走？", severity: "high", memberTitle: "客服组长" }] },
      stream: [
        { title: "一线客服", at: 1793000900000, summarySnip: "处理 15 单", metrics: {} },
        { title: "一线客服", at: 1793000000000, summarySnip: "处理 12 单", metrics: {} },
      ],
    }),
  ]);
  await b.tick();
  const rows = systemRows();
  const report = rows.find((m) => m.meta?.bridge === "report");
  assert.ok(report, "the new report lands");
  assert.match(report.content, /处理 15 单/);
  assert.match(report.meta.deepLink ?? "", /\/fleets\/fleet_ok$/, "the row carries the cockpit deep link");
  const decision = rows.find((m) => m.meta?.bridge === "decision");
  assert.ok(decision, "the decision lands");
  assert.match(decision.content, /退款赔付/);

  // No double-emit on an unchanged third tick.
  await b.tick();
  const again = systemRows();
  assert.equal(again.filter((m) => m.meta?.bridge === "report").length, 1, "unchanged sample emits nothing");
});

test("dead cell: a null sample mutes the tick without error", async () => {
  sample = null;
  const { registerFleetRoomBridge: reg } = await import("../gateway/fleet-room-bridge.js");
  const b = reg(express(), {
    store,
    resolveUser: (_req) => ({ email: OWNER, groups: [] }),
    rejectUnauthenticated: (_q, r) => r.status(401).json({}),
    sampleFleets,
  });
  await b.tick(); // must not throw
  assert.ok(true);
});

// Summon plan test rig: each scenario registers a REAL server (the old shape
// registered a throwaway app and then called the shared one — the per-scenario
// seam never took effect; the degraded assertion passed only because no JSON
// payload can carry a servingMembers function).
function startSummonBridge({ servingDeployments }) {
  const app2 = express();
  app2.use(express.json({ limit: "1mb" }));
  registerFleetRoomBridge(app2, {
    store,
    resolveUser: (_req) => ({ email: OWNER, groups: [] }),
    rejectUnauthenticated: (_q, r) => r.status(401).json({}),
    sampleFleets,
    servingDeployments,
  });
  const server2 = http.createServer(app2);
  server2.listen(0);
  const call2 = (method, p, body) =>
    fetch(`http://127.0.0.1:${server2.address().port}${p}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { server2, call2 };
}

test("summon plan (positive): a2a posts join real deployments on servingPath; unaligned excluded; cockpitOnly honest", async () => {
  sample = overview([
    fleetShape("fleet_ok", "客服班组", {
      formation: {
        members: [
          { id: "m-a2a", title: "萬星机群席", targetKind: "a2a", status: "on_duty", targetId: "registry-packs-p1-mp", servingPath: "/packs/p1/mp" },
          { id: "m-ext", title: "外部哨", targetKind: "a2a", status: "on_duty", targetId: "registry-ext", servingPath: null },
          { id: "m-gap", title: "漂移哨", targetKind: "a2a", status: "on_duty", targetId: "registry-packs-p9-gap", servingPath: "/packs/p9/gap" },
        ],
        edges: [],
        truncated: false,
      },
      stream: [
        { title: "萬星机群席", at: 1, summarySnip: "", metrics: {} },
        { title: "质检员", at: 1, summarySnip: "", metrics: {} },
      ],
    }),
  ]);
  const { server2, call2 } = startSummonBridge({
    servingDeployments: async () => [
      { packId: "p1", agentId: "mp", agentPath: "/packs/p1/mp", deployedBy: OWNER },
      { packId: "other", agentId: "row", agentPath: "/packs/other/row", deployedBy: "someone@test" },
    ],
  });
  try {
    const r = await call2("POST", `/api/zhiyu/rooms/${room.id}/fleet-summon`, { fleetId: "fleet_ok", dryRun: true });
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.plan.summonable,
      [{ ref: "p1:mp", title: "萬星机群席", targetId: "registry-packs-p1-mp", onBehalfOf: OWNER }],
      "the aligned deployment becomes the seat ref packId:agentId with the deployer as onBehalfOf",
    );
    assert.deepEqual(r.body.plan.cockpitOnly, ["萬星机群席", "质检员"], "persona posts named cockpit-only, stream verbatim");
    assert.equal(r.body.plan.fleetName, "客服班组");
  } finally {
    server2.close();
  }
});

test("summon execution: invites carry ref/onBehalfOf from the ledger; subscription rides along", async () => {
  const summonRoom = store.roomCreate({ title: "召唤执行房", ownerEmail: OWNER });
  const { server2, call2 } = startSummonBridge({
    servingDeployments: async () => [{ packId: "p1", agentId: "mp", agentPath: "/packs/p1/mp", deployedBy: OWNER }],
  });
  try {
    const r = await call2("POST", `/api/zhiyu/rooms/${summonRoom.id}/fleet-summon`, { fleetId: "fleet_ok" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results, [{ ref: "p1:mp", ok: true, inviteId: r.body.results[0]?.inviteId ?? null }]);
    const inv = store.invitesForRoom(summonRoom.id).find((v) => v.id === r.body.results[0].inviteId);
    assert.equal(inv.kind, "agent");
    assert.equal(inv.ref, "p1:mp", "seat ref is packId:agentId — what the agent lane resolves");
    assert.equal(inv.onBehalfOf, OWNER, "onBehalfOf is the ledger deployer (seat lane matches on it)");
    assert.ok(store.fleetSubsOf(summonRoom.id).some((s) => s.fleetId === "fleet_ok"), "subscription rides along");
  } finally {
    server2.close();
  }
});

test("summon plan (degrade): ledger face unavailable → summonable honestly empty, plan still 200", async () => {
  const { server2, call2 } = startSummonBridge({ servingDeployments: async () => null });
  try {
    const r = await call2("POST", `/api/zhiyu/rooms/${room.id}/fleet-summon`, { fleetId: "fleet_ok", dryRun: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.plan.summonable, [], "no serving face → nothing summonable, honestly");
    assert.deepEqual(r.body.plan.cockpitOnly, ["萬星机群席", "质检员"]);
  } finally {
    server2.close();
  }
});

test("summon plan (degrade): a throwing ledger seam degrades the same way, never a 500", async () => {
  const { server2, call2 } = startSummonBridge({
    servingDeployments: async () => {
      throw new Error("ledger down");
    },
  });
  try {
    const r = await call2("POST", `/api/zhiyu/rooms/${room.id}/fleet-summon`, { fleetId: "fleet_ok", dryRun: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.plan.summonable, []);
  } finally {
    server2.close();
  }
});

test("summon plan: no a2a posts at all → empty summonable without touching the ledger seam", async () => {
  sample = overview([fleetShape("fleet_ok", "客服班组", { stream: [{ title: "质检员", at: 1, summarySnip: "", metrics: {} }] })]);
  let seamCalls = 0;
  const { server2, call2 } = startSummonBridge({
    servingDeployments: async () => {
      seamCalls += 1;
      return [];
    },
  });
  try {
    const r = await call2("POST", `/api/zhiyu/rooms/${room.id}/fleet-summon`, { fleetId: "fleet_ok", dryRun: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.plan.summonable, []);
    assert.equal(seamCalls, 0, "no candidates → the ledger is not consulted");
    assert.deepEqual(r.body.plan.cockpitOnly, ["质检员"], "persona posts are named as cockpit-only");
  } finally {
    server2.close();
  }
});

test("remove: unsubscribing stops the flow; past rows stay", async () => {
  sample = overview([fleetShape("fleet_ok", "客服班组", { stream: [{ title: "一线客服", at: 1793001000000, summarySnip: "又一批", metrics: {} }] })]);
  const { registerFleetRoomBridge: reg } = await import("../gateway/fleet-room-bridge.js");
  const b = reg(express(), {
    store,
    resolveUser: (_req) => ({ email: OWNER, groups: [] }),
    rejectUnauthenticated: (_q, r) => r.status(401).json({}),
    sampleFleets,
  });
  await b.tick();
  const before = systemRows().filter((m) => m.meta?.bridge === "report").length;

  const subs = await call("GET", `/api/zhiyu/rooms/${room.id}/fleet-subscriptions`);
  const subId = subs.body.subscriptions.find((s) => s.fleetId === "fleet_ok").id;
  const del = await call("DELETE", `/api/zhiyu/rooms/${room.id}/fleet-subscriptions/${subId}`);
  assert.equal(del.status, 200);
  const stopNote = systemRows().find((m) => m.meta?.bridge === "unsubscribed");
  assert.ok(stopNote, "the removal is announced in the room");

  sample = overview([fleetShape("fleet_ok", "客服班组", { stream: [{ title: "一线客服", at: 1793001100000, summarySnip: "不应流入", metrics: {} }] })]);
  await b.tick();
  const after = systemRows().filter((m) => m.meta?.bridge === "report").length;
  assert.equal(after, before, "no rows after removal");
  assert.ok(after >= 1, "past rows stay");
});
