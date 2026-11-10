#!/usr/bin/env node
// ── Cell-report payload shape contract (harden-cell-execution-reliability
//    task 3.3) ────────────────────────────────────────────────────────────────
//
// Spec (harness-adapter, "Core execution modules carry contract tests"):
// `gateway/cell-report.js` — report payload shape.
//
// scripts/test-steward-uplink.mjs pins the steward credential and the relay
// envelope (source=cell-steward, 401, degrade-open). This file pins the
// PAYLOAD WHITELIST itself — what a reported report may carry and what its
// stored/relayed shape is, kind by kind:
//   presence  — whitelist passthrough, state required, junk keys stripped
//   manifest  — numeric fields validated (400 on non-number), labels capped
//               (32 entries × 64 chars, non-strings filtered)
//   detail    — the deep whitelist: every field coerced/capped/type-checked or
//               dropped; content-shaped keys never survive; STORE-ONLY (no
//               relay call, relayed:false)
//   desired   — the pull door's empty and populated shapes, 401 without a
//               steward credential
// No network, no credentials: ingest relay is a captured stub.
//
//   node --test scripts/test-cell-report.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { createCellReportDoor, createDesiredFleetDoor } from "../gateway/cell-report.js";

const WHO = { email: "steward@cell.test", did: "steward-did-1", deviceKind: "steward" };
const INGEST_ENV = { FLEET_INGEST_URL: "https://ingest.cell.test", FLEET_INGEST_TOKEN: "tok" };

// A door with captured relay + captured machines-store writes. The steward
// credential is pinned upstream (test-steward-uplink); here it is a stub.
function makeDoor({ env = INGEST_ENV, machines = null } = {}) {
  const relayed = [];
  const door = createCellReportDoor({
    appAuth: { stewardFromToken: (t) => (t === "good" ? WHO : null) },
    env,
    fetchImpl: async (url, init) => {
      relayed.push({ url, init });
      return { ok: true, status: 202 };
    },
    machines,
  });
  return { door, relayed };
}

// Minimal req/res doubles matching the door's usage — the report door calls
// status().json(), the desired door calls json() directly.
function fakeRes() {
  const out = { code: 200, body: null };
  out.json = (body) => {
    out.body = body;
    return out;
  };
  out.status = (code) => ({
    json: (body) => {
      out.code = code;
      out.body = body;
    },
  });
  return out;
}
const fakeReq = (body) => ({ headers: { authorization: "Bearer good" }, body });

// The machines store double capturing roster liveness + detail writes.
function fakeMachines() {
  const calls = { touch: [], recordDetail: [] };
  return {
    calls,
    touch: (did, patch) => calls.touch.push({ did, patch }),
    recordDetail: (did, detail) => calls.recordDetail.push({ did, detail }),
    get: () => null,
  };
}

async function report(door, payload) {
  const res = fakeRes();
  await door.handle(fakeReq(payload), res);
  return res;
}

test("presence payload: whitelist passthrough with state required and junk keys stripped", async () => {
  const { door, relayed } = makeDoor();

  const ok = await report(door, {
    kind: "presence",
    payload: {
      state: "running",
      os: "darwin",
      appVersion: "1.3.27",
      protocolVersion: 3,
      at: 1_700_000_000_000,
      prompt: "content that must never leave a cell",
      sessions: ["s-1"],
      toolArgs: { x: 1 },
    },
  });
  assert.equal(ok.code, 202);
  assert.ok(ok.body.accepted === true && ok.body.relayed === true);
  const event = JSON.parse(relayed[0].init.body).events[0];
  assert.deepEqual(
    Object.keys(event.payload).sort(),
    ["appVersion", "at", "os", "protocolVersion", "state"],
    "content-shaped keys never pass the presence whitelist",
  );
  assert.equal(event.kind, "cell_presence");

  // state is the one required field — its absence is a 400, not an empty event.
  const missing = await report(door, { kind: "presence", payload: { os: "darwin" } });
  assert.equal(missing.code, 400);
  assert.match(missing.body.error, /presence\.payload\.state is required/);

  // Unknown kinds are refused outright.
  const badKind = await report(door, { kind: "cell_detail_extra", payload: {} });
  assert.equal(badKind.code, 400);
  assert.match(badKind.body.error, /kind must be one of/);
});

test("manifest payload: numeric fields validated and labels capped (32 × 64, strings only)", async () => {
  const { door, relayed } = makeDoor();

  const nonNumber = await report(door, { kind: "manifest", payload: { fleetCount: "many", memberCount: 2 } });
  assert.equal(nonNumber.code, 400);
  assert.match(nonNumber.body.error, /manifest\.payload\.fleetCount must be a number/);

  const junkLabels = await report(door, {
    kind: "manifest",
    payload: {
      fleetCount: 2,
      memberCount: 8,
      enabledTaskCount: 4,
      labels: [3, null, {}, "x".repeat(200), ...Array.from({ length: 40 }, (_, i) => `label-${i}`)],
    },
  });
  assert.equal(junkLabels.code, 202);
  const payload = JSON.parse(relayed[0].init.body).events[0].payload;
  assert.ok(payload.labels.length <= 32, `labels capped at 32 (got ${payload.labels.length})`);
  assert.ok(payload.labels.every((l) => typeof l === "string" && l.length <= 64), "labels are strings ≤64 chars");
  assert.deepEqual(payload.labels[0], "x".repeat(64), "over-long labels are truncated, not dropped");
  assert.ok(payload.labels.includes("label-0"), "legitimate labels survive the cap");
});

test("detail payload: deep whitelist coerces, caps, and drops — and is store-only", async () => {
  const machines = fakeMachines();
  const { door, relayed } = makeDoor({ machines });

  const longStr = "y".repeat(500);
  const res = await report(door, {
    kind: "detail",
    payload: {
      at: "not-a-number",
      capacity: { used: "12", cap: Number.NaN, unit: longStr },
      deployments: [
        { agentPath: longStr, packId: "pack-1", agentId: "a-1", enabled: true, source: "cloud", prompt: "junk" },
        { enabled: "yes", source: "smuggled" },
        ...Array.from({ length: 70 }, (_, i) => ({ agentId: `d-${i}` })),
      ],
      agents: [
        { key: "k1", state: "serving", port: "9001", version: "3.9" },
        { key: "k2", state: "possessed", port: -1.5 },
        ...Array.from({ length: 70 }, (_, i) => ({ key: `a-${i}` })),
      ],
      merge: { desiredVersionSeen: 7, rejects: [{ agentPath: "p", code: longStr }, ...Array.from({ length: 70 }, (_, i) => ({ code: `r-${i}` }))] },
      steward: { crashRestarts: 0, pullFailures: "2" },
      prompt: "session content",
      sessions: ["s-9"],
      transcript: { deep: "content" },
    },
  });
  assert.equal(res.code, 202);
  assert.deepEqual(res.body, { accepted: true, relayed: false }, "cell_detail is store-only: accepted, never relayed");
  assert.equal(relayed.length, 0, "no ingest call happens for detail");

  const detail = machines.calls.recordDetail[0].detail;
  assert.equal(machines.calls.recordDetail[0].did, WHO.did, "the detail lands on the token's own machine");
  assert.ok(Number.isFinite(detail.at), "a non-numeric at falls back to Date.now()");
  assert.equal(detail.capacity.used, 12, "numeric strings coerce");
  assert.equal(detail.capacity.cap, null, "non-finite numbers coerce to null");
  assert.equal(detail.capacity.unit, "y".repeat(200), "strings cap at 200 chars");
  assert.equal(detail.deployments.length, 64, "deployments cap at 64");
  assert.equal(detail.deployments[0].agentPath, "y".repeat(200));
  assert.equal(detail.deployments[0].enabled, true);
  assert.equal(detail.deployments[0].source, "cloud");
  assert.ok(!("prompt" in detail.deployments[0]), "content keys never ride a deployment row");
  assert.equal(detail.deployments[1].enabled, false, "enabled only passes on strict true");
  assert.equal(detail.deployments[1].source, "manual", "unknown sources fail closed to manual");
  assert.equal(detail.agents.length, 64, "agents cap at 64");
  assert.equal(detail.agents[0].state, "serving");
  assert.equal(detail.agents[0].port, 9001, "port coerces");
  assert.equal(detail.agents[0].version, 3, "version truncates to an integer");
  assert.equal(detail.agents[1].state, "unknown", "unknown states fail closed to unknown");
  assert.equal(detail.merge.desiredVersionSeen, 7);
  assert.equal(detail.merge.rejects.length, 64, "rejects cap at 64");
  assert.equal(detail.merge.rejects[0].code, "y".repeat(200));
  assert.equal(detail.steward.pullFailures, 2, "steward counters coerce");
  assert.ok(
    !("prompt" in detail) && !("sessions" in detail) && !("transcript" in detail),
    "content-shaped top-level keys never survive the deep whitelist",
  );

  // Roster liveness rides the same door, but detail reports no presence.
  assert.equal(machines.calls.touch.length, 1);
  assert.equal(machines.calls.touch[0].did, WHO.did);
  assert.equal(machines.calls.touch[0].patch.presence, undefined, "detail refreshes liveness without a presence payload");
});

test("desired-fleet door: steward-gated, empty by default, self-scoped populated shape", async () => {
  // No steward credential → 401 before any store read.
  const gate = createDesiredFleetDoor({ appAuth: { stewardFromToken: () => null }, machines: fakeMachines() });
  const denied = fakeRes();
  await gate.handle(fakeReq({}), denied);
  assert.equal(denied.code, 401);

  // No desired row → the empty shape (version 0), never an error.
  const emptyStore = fakeMachines();
  const emptyDoor = createDesiredFleetDoor({
    appAuth: { stewardFromToken: () => WHO },
    machines: emptyStore,
  });
  const empty = fakeRes();
  await emptyDoor.handle(fakeReq({}), empty);
  assert.equal(empty.code, 200);
  assert.deepEqual(empty.body, { version: 0, entries: [] });

  // A desired row lands verbatim with its version and updatedAt.
  const desired = {
    version: 4,
    at: 1_700_000_000_000,
    entries: [{ packId: "pack-1", agentId: "a-1", enabled: true }],
  };
  const rowStore = { get: (did) => (did === WHO.did ? { desired } : null) };
  const rowDoor = createDesiredFleetDoor({ appAuth: { stewardFromToken: () => WHO }, machines: rowStore });
  const populated = fakeRes();
  await rowDoor.handle(fakeReq({}), populated);
  assert.equal(populated.code, 200);
  assert.deepEqual(populated.body, { version: 4, entries: desired.entries, updatedAt: desired.at });
});
