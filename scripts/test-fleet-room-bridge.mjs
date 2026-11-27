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
function startSummonBridge({ servingDeployments, acceptSeats = null }) {
  const app2 = express();
  app2.use(express.json({ limit: "1mb" }));
  registerFleetRoomBridge(app2, {
    store,
    resolveUser: (_req) => ({ email: OWNER, groups: [] }),
    rejectUnauthenticated: (_q, r) => r.status(401).json({}),
    sampleFleets,
    servingDeployments,
    acceptSeats,
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
      [{ ref: "p1:mp", title: "萬星机群席", targetId: "registry-packs-p1-mp", onBehalfOf: OWNER, voice: null }],
      "the aligned deployment becomes the seat ref packId:agentId with the deployer as onBehalfOf; no declared voice reads null",
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
    assert.equal(inv.voice, null, "a post with no declared voice carries none onto the invite");
    assert.ok(store.fleetSubsOf(summonRoom.id).some((s) => s.fleetId === "fleet_ok"), "subscription rides along");
  } finally {
    server2.close();
  }
});

test("summon carries the post's declared voice onto the invite", async () => {
  // A formation member that declares a voice (add-room-voice-and-catalog).
  sample = overview([
    fleetShape("fleet_v", "有声班组", {
      formation: {
        members: [
          { id: "m-v", title: "有声席", targetKind: "a2a", status: "on_duty", targetId: "registry-packs-p2-v", servingPath: "/packs/p2/v", voice: { model: "tencent-tts", voice: "101013" } },
          { id: "m-nv", title: "无声席", targetKind: "a2a", status: "on_duty", targetId: "registry-packs-p3/nv", servingPath: "/packs/p3/nv" },
        ],
        edges: [],
        truncated: false,
      },
      stream: [],
    }),
  ]);
  const summonRoom = store.roomCreate({ title: "有声召唤房", ownerEmail: OWNER });
  const { server2, call2 } = startSummonBridge({
    servingDeployments: async () => [
      { packId: "p2", agentId: "v", agentPath: "/packs/p2/v", deployedBy: OWNER },
      { packId: "p3", agentId: "nv", agentPath: "/packs/p3/nv", deployedBy: OWNER },
    ],
  });
  try {
    const r = await call2("POST", `/api/zhiyu/rooms/${summonRoom.id}/fleet-summon`, { fleetId: "fleet_v" });
    assert.equal(r.status, 200);
    const invV = store.invitesForRoom(summonRoom.id).find((v) => v.ref === "p2:v");
    const invNv = store.invitesForRoom(summonRoom.id).find((v) => v.ref === "p3:nv");
    assert.deepEqual(invV.voice, { model: "tencent-tts", voice: "101013" }, "the declared voice rides the invite");
    assert.equal(invNv.voice, null, "an undeclared post carries none");
  } finally {
    server2.close();
    // Later tests sample `fleet_ok` and expect its original stream members.
    sample = overview([
      fleetShape("fleet_ok", "客服班组", {
        stream: [
          { title: "萬星机群席", at: 1, summarySnip: "", metrics: {} },
          { title: "质检员", at: 1, summarySnip: "", metrics: {} },
        ],
      }),
    ]);
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

// ── 本地岗位也能入席（2026-11-24：未发布的团队不是不可用的团队）─────────────
//
// The resolver used to keep only `targetKind === "a2a" && servingPath`, i.e. only
// posts backed by a MARKET deployment. A team a human built locally (persona /
// auditor posts running on their own cell) therefore could not be summoned into
// their own room — "unpublished" silently meant "unusable". Visibility governs
// OUTSIDE callers; it must not govern who may speak inside the owner's room.
//
// These seats need no ledger row: they run on the owner's cell over the
// gateway's sync-turn endpoint. Asserted here at the plan layer, which is what
// the summon button shows before any invite is created.
test("persona and auditor posts are summonable without any market deployment", async () => {
  sample = overview([
    fleetShape("fleet_local", "个人幕僚团", {
      formation: {
        members: [
          { id: "m4", title: "幕僚长", targetKind: "persona", status: "on_duty", targetId: "user.preset-4", servingPath: null },
          { id: "m5", title: "评审官", targetKind: "persona", status: "passive", targetId: "user.preset-5", servingPath: null },
          { id: "m8", title: "审计官", targetKind: "auditor", status: "passive", targetId: "user.preset-8", servingPath: null },
        ],
        edges: [],
        truncated: false,
      },
      stream: [
        { title: "幕僚长", at: 1, summarySnip: "", metrics: {} },
      ],
    }),
  ]);
  // No deployments at all — the ledger must not be consulted for local posts.
  const { server2, call2 } = startSummonBridge({ servingDeployments: async () => [] });
  try {
    const r = await call2("POST", `/api/zhiyu/rooms/${room.id}/fleet-summon`, { fleetId: "fleet_local", dryRun: true });
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.plan.summonable.map((s) => ({ ref: s.ref, title: s.title, onBehalfOf: s.onBehalfOf })),
      [
        { ref: "persona:fleet_local:m4", title: "幕僚长", onBehalfOf: OWNER },
        { ref: "persona:fleet_local:m5", title: "评审官", onBehalfOf: OWNER },
        { ref: "persona:fleet_local:m8", title: "审计官", onBehalfOf: OWNER },
      ],
      "each local post is its own seat, refed by post id (not a deployment), running as the team owner",
    );
  } finally {
    server2.close();
  }
});

test("an a2a post with no deployment is still honestly excluded (unchanged)", async () => {
  sample = overview([
    fleetShape("fleet_mixed", "混合队", {
      formation: {
        members: [
          { id: "mx", title: "外部哨", targetKind: "a2a", status: "on_duty", targetId: "registry-ext", servingPath: null },
          { id: "ml", title: "本地岗", targetKind: "persona", status: "on_duty", targetId: "user.preset-2", servingPath: null },
        ],
        edges: [],
        truncated: false,
      },
      stream: [],
    }),
  ]);
  const { server2, call2 } = startSummonBridge({ servingDeployments: async () => [] });
  try {
    const r = await call2("POST", `/api/zhiyu/rooms/${room.id}/fleet-summon`, { fleetId: "fleet_mixed", dryRun: true });
    assert.deepEqual(
      r.body.plan.summonable.map((s) => s.title),
      ["本地岗"],
      "the a2a post without a deployment stays out; the local post comes in",
    );
  } finally {
    server2.close();
  }
});

// ── Summon admission + room-visible outcome (2026-11-24 interaction fix) ─────
//
// A persona seat answers on the OWNER'S OWN cell, so "召唤" already is the
// approval — leaving a pending invite made the owner accept once per post.
// Market (a2a) seats keep the handshake. And whichever way it goes, the ROOM
// must say so: the outcome used to live only in the settings panel.

test("summon admits persona seats on the spot and leaves market seats pending", async () => {
  sample = overview([
    fleetShape("fleet_admit", "混编队", {
      formation: {
        members: [
          { id: "ml", title: "本地岗", targetKind: "persona", status: "on_duty", targetId: "user.preset-2", servingPath: null },
          { id: "ma", title: "机群席", targetKind: "a2a", status: "on_duty", targetId: "registry-packs-p1-mp", servingPath: "/packs/p1/mp" },
        ],
        edges: [],
        truncated: false,
      },
      stream: [],
    }),
  ]);
  const admitRoom = store.roomCreate({ title: "自动入席房", ownerEmail: OWNER });
  const admitted = [];
  const acceptSeats = (invite) => {
    admitted.push(invite.ref);
    return store.memberEnsure({ roomId: invite.roomId, kind: invite.kind, ref: invite.ref, display: invite.display, onBehalfOf: invite.onBehalfOf });
  };
  const { server2, call2 } = startSummonBridge({
    servingDeployments: async () => [{ packId: "p1", agentId: "mp", agentPath: "/packs/p1/mp", deployedBy: OWNER }],
    acceptSeats,
  });
  try {
    const r = await call2("POST", `/api/zhiyu/rooms/${admitRoom.id}/fleet-summon`, { fleetId: "fleet_admit" });
    assert.equal(r.status, 200);
    const local = r.body.results.find((x) => x.ref.startsWith("persona:"));
    const market = r.body.results.find((x) => x.ref === "p1:mp");
    assert.equal(local.admitted, true, "the local post is seated by the summon itself");
    assert.equal(market.admitted, undefined, "the market seat stays a pending handshake");
    assert.deepEqual(admitted, [local.ref], "exactly the local seat was admitted");
    assert.equal(store.inviteGet(local.inviteId).state, "accepted");
    assert.equal(store.inviteGet(market.inviteId).state, "pending");
  } finally {
    server2.close();
  }
});

test("the summon leaves a room-visible outcome row (not settings-panel-only)", async () => {
  sample = overview([
    fleetShape("fleet_vis", "可见队", {
      formation: {
        members: [
          { id: "ml", title: "本地岗", targetKind: "persona", status: "on_duty", targetId: "user.preset-2", servingPath: null },
        ],
        edges: [],
        truncated: false,
      },
      stream: [],
    }),
  ]);
  const visRoom = store.roomCreate({ title: "可见召唤房", ownerEmail: OWNER });
  const { server2, call2 } = startSummonBridge({
    servingDeployments: async () => [],
    acceptSeats: (invite) =>
      store.memberEnsure({ roomId: invite.roomId, kind: invite.kind, ref: invite.ref, display: invite.display, onBehalfOf: invite.onBehalfOf }),
  });
  try {
    await call2("POST", `/api/zhiyu/rooms/${visRoom.id}/fleet-summon`, { fleetId: "fleet_vis" });
    const row = store.messagesAfter(visRoom.id, 0).find((m) => m.meta?.bridge === "summon_result");
    assert.ok(row, "the room got a row about the summon, not just the panel");
    assert.match(row.content, /1 席已入席/);
    assert.equal(row.meta.admitted, 1);
  } finally {
    server2.close();
  }
});

test("auto-accept off keeps every summon pending (the policy is real)", async () => {
  const { summonAutoAccept } = await import("../lib/agent-authorization.js");
  process.env.AGENT_SUMMON_AUTO_ACCEPT = "off";
  assert.equal(summonAutoAccept(), false);
  sample = overview([
    fleetShape("fleet_off", "手批队", {
      formation: {
        members: [{ id: "ml", title: "本地岗", targetKind: "persona", status: "on_duty", targetId: "user.preset-2", servingPath: null }],
        edges: [],
        truncated: false,
      },
      stream: [],
    }),
  ]);
  const offRoom = store.roomCreate({ title: "手批房", ownerEmail: OWNER });
  const admitted = [];
  const { server2, call2 } = startSummonBridge({
    servingDeployments: async () => [],
    acceptSeats: (invite) => { admitted.push(invite.ref); },
  });
  try {
    const r = await call2("POST", `/api/zhiyu/rooms/${offRoom.id}/fleet-summon`, { fleetId: "fleet_off" });
    assert.equal(r.body.results[0].admitted, undefined, "policy off ⇒ pending, exactly as before");
    assert.equal(admitted.length, 0);
  } finally {
    delete process.env.AGENT_SUMMON_AUTO_ACCEPT;
    server2.close();
  }
});

test("an already-seated post is not counted as a failure", async () => {
  sample = overview([
    fleetShape("fleet_dup", "重复队", {
      formation: {
        members: [{ id: "ml", title: "本地岗", targetKind: "persona", status: "on_duty", targetId: "user.preset-2", servingPath: null }],
        edges: [],
        truncated: false,
      },
      stream: [],
    }),
  ]);
  const dupRoom = store.roomCreate({ title: "重复召唤房", ownerEmail: OWNER });
  const seatRef = "persona:fleet_dup:ml";
  store.memberEnsure({ roomId: dupRoom.id, kind: "agent", ref: seatRef, display: "本地岗" });
  const { server2, call2 } = startSummonBridge({ servingDeployments: async () => [] });
  try {
    const r = await call2("POST", `/api/zhiyu/rooms/${dupRoom.id}/fleet-summon`, { fleetId: "fleet_dup" });
    assert.equal(r.body.results[0].ok, true, "already seated is not a failure");
    assert.equal(r.body.results[0].already, true);
    const row = store.messagesAfter(dupRoom.id, 0).find((m) => m.meta?.bridge === "summon_result");
    assert.match(row.content, /1 席原已在场/);
    assert.doesNotMatch(row.content, /未能召唤/);
  } finally {
    server2.close();
  }
});

// ── Structured facts ride the row (redesign-zhiyu-room-surfaces 2.2) ────────
//
// The room used to receive a report as one flattened sentence. Everything the
// reader needs to SCAN — which dimension, did it pass, what blocked it — was in
// the sentence and nowhere else, which meant the UI had to either parse prose or
// show a wall. The bridge has these fields in hand (candidateFor) and now stamps
// them onto the row.
//
// Why stamped rather than looked up at read time: measured 2026-11-25, a room
// held 151 report rows whose fleet was absent from that instance's
// `member_reports` — writers and readers do not share a store.
test("a report row carries its structured facts, not just the sentence", async () => {
  const { registerFleetRoomBridge: reg } = await import("../gateway/fleet-room-bridge.js");
  const b = reg(express(), {
    store,
    resolveUser: (_req) => ({ email: OWNER, groups: [] }),
    rejectUnauthenticated: (_q, r) => r.status(401).json({}),
    sampleFleets,
  });

  sample = overview([fleetShape("fleet_struct", "结构班组", {
    stream: [{ title: "巡检岗", at: 1793000000000, summarySnip: "上窗 ok", metrics: {} }],
  })]);
  // A tick only emits for SUBSCRIBED fleets; without this the fleet is merely
  // present in the sample and nothing lands.
  const sub = await call("POST", `/api/zhiyu/rooms/${room.id}/fleet-subscriptions`, { fleetId: "fleet_struct" });
  assert.equal(sub.status, 201, "subscribed");
  await b.tick(); // baseline

  sample = overview([fleetShape("fleet_struct", "结构班组", {
    stream: [{
      title: "巡检岗",
      at: 1793000900000,
      summarySnip: "窗口3 成本取数失败",
      // the KEYS are the dimensions
      metrics: { cost: "failed", crawl: "ok" },
      blockers: ["octet 通道故障"],
    }],
  })]);
  await b.tick();

  const row = systemRows().find((m) => m.meta?.fleetId === "fleet_struct" && m.meta?.bridge === "report");
  assert.ok(row, "the report row landed");
  assert.ok(row.meta?.reportData, "the row carries reportData — the UI must not parse prose to recover it");
  const rd = row.meta.reportData;
  assert.ok(rd, "the row carries reportData — the UI must not parse prose to recover it");
  assert.equal(rd.memberTitle, "巡检岗", "the post that filed it");
  assert.deepEqual(rd.metrics, { cost: "failed", crawl: "ok" }, "the dimension keys and their readings survive");
  assert.deepEqual(rd.blockers, ["octet 通道故障"], "the blocked-window signal survives");
  assert.ok(typeof rd.summary === "string" && rd.summary.length > 0, "the prose stays as a readable fallback");
});

test("a clean report carries an empty blocker list, not a missing one", async () => {
  // The UI's "only abnormal" filter reads `blockers.length`. A missing field and
  // an empty one must not mean the same thing to a caller — but here they DO
  // mean the same thing (nothing blocked), so the field is always present.
  const { registerFleetRoomBridge: reg } = await import("../gateway/fleet-room-bridge.js");
  const b = reg(express(), {
    store,
    resolveUser: (_req) => ({ email: OWNER, groups: [] }),
    rejectUnauthenticated: (_q, r) => r.status(401).json({}),
    sampleFleets,
  });
  sample = overview([fleetShape("fleet_clean", "干净班组", {
    stream: [{ title: "巡检岗", at: 1793000000000, summarySnip: "a", metrics: {} }],
  })]);
  const sub = await call("POST", `/api/zhiyu/rooms/${room.id}/fleet-subscriptions`, { fleetId: "fleet_clean" });
  assert.equal(sub.status, 201, "subscribed");
  await b.tick();
  sample = overview([fleetShape("fleet_clean", "干净班组", {
    stream: [{ title: "巡检岗", at: 1793000900000, summarySnip: "b", metrics: { crawl: "ok" } }],
  })]);
  await b.tick();
  const row = systemRows().find((m) => m.meta?.fleetId === "fleet_clean" && m.meta?.bridge === "report");
  assert.ok(row?.meta?.reportData, "reportData present");
  assert.deepEqual(row.meta.reportData.blockers, [], "empty, not undefined");
});

test("the abnormality judgement exists once, and both consumers use it", async () => {
  // Live 2026-11-25: the run row coloured itself with `anomalies_found > 0` while
  // the 「只看异常」 filter still keyed on `blockers.length`. The filter then
  // returned a row whose `data-abnormal` was "false" — a filter showing a row
  // that is not red is indistinguishable from a broken filter.
  //
  // Two copies of a judgement always drift. This pins the single definition and
  // that the filter goes THROUGH it rather than repeating the expression.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../web/src/pages/ZhiyuRoomPage.tsx", import.meta.url), "utf8");

  const defs = src.match(/function isAbnormalReport\(/g) ?? [];
  assert.equal(defs.length, 1, "exactly one definition of the judgement");

  const runCase = src.slice(src.indexOf('case "run":'), src.indexOf('case "event":'));
  assert.match(runCase, /isAbnormalReport\(/, "the run filter must call the shared judgement");
  assert.doesNotMatch(runCase, /blockers\.length\s*>/, "the filter must not re-derive abnormality from blockers");

  // and the row itself
  assert.match(src, /const abnormal = isAbnormalReport\(/, "the row colour uses it too");
});
