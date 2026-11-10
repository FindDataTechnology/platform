#!/usr/bin/env node
// ── Production assembly order: /api/zhiyu/* 404 guard must come LAST ───────
//
// Regression gate for fix-zhiyu-fleet-bridge-route-order. The bug: the prefix
// 404 catch-all was registered INSIDE registerZhiyuRoutes, before
// registerFleetRoomBridge mounted its four endpoints on the same app, so all
// four were unreachable in production while every isolated bridge test passed.
//
// This suite mounts the real modules on ONE express() in production order and
// asserts reachability. It deliberately includes a negative case that puts the
// guard back before the bridge, proving the test can catch a regression.
//
//   node --test scripts/test-zhiyu-route-assembly.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";
import { registerFleetRoomBridge } from "../gateway/fleet-room-bridge.js";

const OWNER = "owner@test";
const OWNED_FLEET = "fleet_owned_1";
const FOREIGN_FLEET = "fleet_foreign_1";

// The bridge's ownership gate reads the owner's live fleet overview.
const sampleFleets = async () => ({
  fleets: [
    { id: OWNED_FLEET, name: "自有团队", stream: [], counts: {}, openDecisions: { count: 0, top: [] } },
  ],
});

// fix-zhiyu-summon-serving-face 3.2: an overview WITH an a2a post carrying a
// servingPath — the positive-plan fixture.
const sampleFleetsWithServing = async () => ({
  fleets: [
    {
      id: OWNED_FLEET,
      name: "自有团队",
      stream: [{ title: "萬星机群席", at: 1, summarySnip: "", metrics: {} }],
      counts: {},
      openDecisions: { count: 0, top: [] },
      formation: {
        members: [
          { id: "m1", title: "萬星机群席", targetKind: "a2a", status: "on_duty", targetId: "registry-packs-p1-mp", servingPath: "/packs/p1/mp" },
        ],
        edges: [],
        truncated: false,
      },
    },
  ],
});

async function boot({ deferNotFound, guardBeforeBridge = false, servingDeployments } = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-assembly-"));

  let cellProxyHits = 0;
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    ssePollMs: 60,
    startTimers: false,
    ...(deferNotFound === undefined ? {} : { deferNotFound }),
  });

  // Production order: room kernel -> IM bridge (inside registerZhiyuRoutes)
  // -> fleet bridge -> 404 guard -> cell proxy.
  if (guardBeforeBridge && deferNotFound) zhiyu.registerNotFound();

  const bridge = registerFleetRoomBridge(app, {
    store: zhiyu.store,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    sampleFleets: servingDeployments === undefined ? sampleFleets : sampleFleetsWithServing,
    ...(servingDeployments === undefined ? {} : { servingDeployments }),
  });

  // A stand-in for gateway/index.js:1116 — records any request that falls
  // through past every /api/zhiyu/* route. Mounted AFTER the 404 guard
  // (D4): in production the guard is registered before the cell proxy.
  const cellProxy = (_req, res) => {
    cellProxyHits += 1;
    res.status(599).json({ error: "cell proxy reached" });
  };

  if (deferNotFound && guardBeforeBridge) {
    // Deliberate bug shape: guard before the bridge; the proxy still goes
    // last so the negative case only isolates the guard/bridge order.
    app.use(cellProxy);
  } else if (deferNotFound) {
    zhiyu.registerNotFound();
    app.use(cellProxy);
  } else {
    // Default path: registerZhiyuRoutes mounted the guard inline already.
    app.use(cellProxy);
  }

  const room = zhiyu.store.roomCreate({ title: "装配顺序房", ownerEmail: OWNER });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const call = async (method, p, body, email = OWNER) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, {
      method,
      headers: { "x-user": email, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  return {
    srv, tmp, room, call, bridge,
    hits: () => cellProxyHits,
    close: () => { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

// ── 3.2 四条桥端点在完整装配下可达，且沿用既有所有权/成员闸 ──────────────
test("production assembly: four fleet-bridge endpoints are reachable", async (t) => {
  const h = await boot({ deferNotFound: true });
  t.after(h.close);
  const R = h.room.id;
  const P = `/api/zhiyu/rooms/${R}`;

  const getBefore = await h.call("GET", `${P}/fleet-subscriptions`);
  assert.notEqual(getBefore.status, 404, "GET subscriptions must not be swallowed by the 404 guard");
  assert.equal(getBefore.status, 200);
  assert.deepEqual(getBefore.body.subscriptions, []);

  const post = await h.call("POST", `${P}/fleet-subscriptions`, { fleetId: OWNED_FLEET });
  assert.notEqual(post.status, 404, "POST subscriptions must reach the ownership gate");
  assert.equal(post.status, 201, JSON.stringify(post.body));
  assert.equal(post.body.subscription.fleetId, OWNED_FLEET);

  const getAfter = await h.call("GET", `${P}/fleet-subscriptions`);
  assert.equal(getAfter.status, 200);
  assert.equal(getAfter.body.subscriptions.length, 1, "first sight baselines silently; no history dump");

  const subId = post.body.subscription.id;
  const del = await h.call("DELETE", `${P}/fleet-subscriptions/${subId}`);
  assert.notEqual(del.status, 404, "DELETE subscription must reach the bridge");
  assert.equal(del.status, 200, JSON.stringify(del.body));

  const plan = await h.call("POST", `${P}/fleet-summon`, { fleetId: OWNED_FLEET, dryRun: true });
  assert.notEqual(plan.status, 404, "summon plan must reach the bridge");
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.ok(Array.isArray(plan.body.plan.summonable), "plan exposes summonable members");
  assert.ok(Array.isArray(plan.body.plan.cockpitOnly), "plan exposes cockpit-only posts");
});

test("production assembly: ownership gate still rejects foreign fleets indistinguishably", async (t) => {
  const h = await boot({ deferNotFound: true });
  t.after(h.close);
  const P = `/api/zhiyu/rooms/${h.room.id}`;
  const foreign = await h.call("POST", `${P}/fleet-subscriptions`, { fleetId: FOREIGN_FLEET });
  assert.equal(foreign.status, 404, "a fleet not in the owner sample must be 404, not 'not found' by guard");
  assert.deepEqual(foreign.body, { error: "not found" });

  const stranger = await h.call("GET", `${P}/fleet-subscriptions`, undefined, "stranger@test");
  assert.equal(stranger.status, 404, "a non-member must not see the room");
});

// ── 3.3 兜底仍挡住未匹配路径，且不落到 cell 代理 ──────────────────────────
test("production assembly: unmatched /api/zhiyu/* still 404s and never reaches the cell proxy", async (t) => {
  const h = await boot({ deferNotFound: true });
  t.after(h.close);
  const unmatched = await h.call("GET", "/api/zhiyu/no-such-route-xyz");
  assert.equal(unmatched.status, 404);
  assert.deepEqual(unmatched.body, { error: "not found" });
  assert.equal(h.hits(), 0, "cell proxy must not be reached for unmatched zhiyu paths");
});

// ── 3.4 负例回归闸：把兜底提前，桥端点重新变 404 ─────────────────────────
test("regression gate: moving the 404 guard before the bridge makes endpoints unreachable", async (t) => {
  const h = await boot({ deferNotFound: true, guardBeforeBridge: true });
  t.after(h.close);
  const P = `/api/zhiyu/rooms/${h.room.id}`;
  for (const [method, p, body] of [
    ["GET", `${P}/fleet-subscriptions`, undefined],
    ["POST", `${P}/fleet-subscriptions`, { fleetId: OWNED_FLEET }],
    ["DELETE", `${P}/fleet-subscriptions/nope`, undefined],
    ["POST", `${P}/fleet-summon`, { fleetId: OWNED_FLEET, dryRun: true }],
  ]) {
    const r = await h.call(method, p, body);
    assert.equal(r.status, 404, `${method} ${p} must be swallowed by an early guard (bug shape)`);
  }
});

// ── 3.5 对照组：deferNotFound 缺省时内联兜底仍在（9 套既有测试依赖）──────
test("default assembly: inline 404 guard is unchanged when deferNotFound is omitted", async (t) => {
  const h = await boot();
  t.after(h.close);
  const unmatched = await h.call("GET", "/api/zhiyu/no-such-route-xyz");
  assert.equal(unmatched.status, 404);
  assert.deepEqual(unmatched.body, { error: "not found" });
  assert.equal(h.hits(), 0);
});

// ── fix-zhiyu-summon-serving-face 3.2：装配级正路径 ──────────────────────────
// 生产序装配 + 双缝 stub（overview 带 a2a 岗 servingPath + deployments 台账）
// → dryRun 计划的 summonable 非空且逐成员带席位引用；台账面缺席仍 200 空降级。
test("production assembly: summon plan joins a2a posts to the deployment ledger", async (t) => {
  const h = await boot({
    deferNotFound: true,
    servingDeployments: async () => [{ packId: "p1", agentId: "mp", agentPath: "/packs/p1/mp", deployedBy: "owner@test" }],
  });
  t.after(h.close);
  const P = `/api/zhiyu/rooms/${h.room.id}`;
  const plan = await h.call("POST", `${P}/fleet-summon`, { fleetId: OWNED_FLEET, dryRun: true });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.deepEqual(
    plan.body.plan.summonable,
    [{ ref: "p1:mp", title: "萬星机群席", targetId: "registry-packs-p1-mp", onBehalfOf: "owner@test" }],
    "seat ref = packId:agentId, onBehalfOf = ledger deployer",
  );
  assert.deepEqual(plan.body.plan.cockpitOnly, ["萬星机群席"]);
});

test("production assembly: summon plan degrades to empty summonable when the ledger is unreachable", async (t) => {
  const h = await boot({ deferNotFound: true, servingDeployments: async () => null });
  t.after(h.close);
  const P = `/api/zhiyu/rooms/${h.room.id}`;
  const plan = await h.call("POST", `${P}/fleet-summon`, { fleetId: OWNED_FLEET, dryRun: true });
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.body.plan.summonable, []);
  assert.deepEqual(plan.body.plan.cockpitOnly, ["萬星机群席"], "cockpitOnly stays honest");
});
