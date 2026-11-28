// Unit tests — fleet machines store + steward doors + machines console routes
// (add-unified-fleet-console 1.2 / 2.1–2.4).
// Run: node --test scripts/test-fleet-machines.mjs
//
//  1.x  store: touch liveness, detail overwrite, desired version increments,
//       divergence counts ONLY missing cloud-desired entries (manual extras
//       never alarm), JSON roundtrip.
//  2.x  reporting door: presence/manifest relay as before; cell_detail accepted
//       store-only, deep-whitelisted (content-shaped fields stripped);
//       401 without a steward credential.
//  3.x  desired door: self-scoped by the token's did (no device parameter
//       exists), empty until a desired set is recorded, 401 otherwise.
//  4.x  console routes: 401 unauthenticated; roster lists steward-kind pairings
//       only; ownership 404 on another account's device; PUT desired validates
//       shape and bumps version; admin view reads across accounts.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-machines-"));
const STORE_FILE = path.join(TMP, "fleet-machines.json");

const { createFleetMachinesStore } = await import("../gateway/fleet-machines-store.js");
const { createCellReportDoor, createDesiredFleetDoor } = await import("../gateway/cell-report.js");
const { registerFleetMachineRoutes, deriveMachineHealth } = await import("../gateway/fleet-machines-routes.js");
const { createAppAuth } = await import("../gateway/app-auth.js");
const { createMpBindings } = await import("../gateway/mp-bindings.js");

// ── Shared fixture: one bindings store, two steward devices (different
// accounts), one app device, one live door stack. ─────────────────────────────
const bindings = createMpBindings({ file: path.join(TMP, "mp-bindings.json") });
const appAuth = createAppAuth({ tokenSecret: "test-secret", ttlHours: 1, bindings: bindings.load ? bindings : null });

async function pairSteward(deviceId, email, kind = "steward") {
  const code = bindings.issueBindCode(email, ["admin"]).code;
  const pubkey = crypto.randomBytes(32).toString("base64url"); // 43 chars, matches PUBKEY_RE
  const r = await appAuth.pair({ code, deviceId, pubkey, label: "dev-" + deviceId, kind });
  assert.equal(r.ok, true, `pair failed: ${r.error}`);
  return r.token;
}

const now = Date.now();
const store = createFleetMachinesStore({ file: STORE_FILE, now: () => now });
await store.load();

const DOG_TOKEN = await pairSteward("dev-dog", "owner@test");
const CAT_TOKEN = await pairSteward("dev-cat", "other@test");
await pairSteward("dev-app", "owner@test", "app");

function auth(token) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

// ── 1.x store ────────────────────────────────────────────────────────────────

test("1.1 touch upserts liveness + ownerEmail without clobbering detail", () => {
  store.touch("dev-dog", { ownerEmail: "owner@test", presence: { state: "running" } });
  const row = store.get("dev-dog");
  assert.equal(row.lastSeenAt, now);
  assert.equal(row.ownerEmail, "owner@test");
  assert.deepEqual(row.presence, { state: "running" });
  assert.equal(row.detail, null);
  assert.equal(row.divergenceStreak, 0);
});

test("1.2 recordDetail overwrites per device and derives divergence only from cloud-desired entries", () => {
  store.recordDesired("dev-dog", [
    { packId: "p1", agentId: "a1", enabled: true },
    { packId: "p1", agentId: "a2", enabled: true },
  ]);
  // All desired entries live → streak resets to 0; a manual extra is NOT divergence.
  store.recordDetail("dev-dog", {
    deployments: [
      { agentPath: "p1/a1", packId: "p1", agentId: "a1", enabled: true, source: "cloud" },
      { agentPath: "p1/a2", packId: "p1", agentId: "a2", enabled: true, source: "cloud" },
      { agentPath: "p9/x", packId: "p9", agentId: "x", enabled: true, source: "manual" },
    ],
  });
  assert.equal(store.get("dev-dog").divergenceStreak, 0);
  // Desired entry missing → streak climbs per snapshot.
  store.recordDetail("dev-dog", { deployments: [{ agentPath: "p1/a1", packId: "p1", agentId: "a1", enabled: true, source: "cloud" }] });
  assert.equal(store.get("dev-dog").divergenceStreak, 1);
  // A disabled desired entry is not expected to run → not divergence.
  store.recordDesired("dev-dog", [{ packId: "p1", agentId: "a1", enabled: false }]);
  store.recordDetail("dev-dog", { deployments: [] });
  assert.equal(store.get("dev-dog").divergenceStreak, 0);
});

test("1.3 desired edits bump the version and persist across reload", async () => {
  const v1 = store.recordDesired("dev-cat", [{ packId: "p2", agentId: "b1", enabled: true }], { ownerEmail: "other@test" }).desired.version;
  const v2 = store.recordDesired("dev-cat", [{ packId: "p2", agentId: "b1", enabled: false }]).desired.version;
  assert.equal(v2, v1 + 1);
  // No explicit persist() here on purpose: the write must be self-persisting.
  // This test used to call it itself, which is exactly why a gateway restart
  // silently wiped every expectation in production (2026-10-30 walkthrough).
  await store.flush;
  const reloaded = createFleetMachinesStore({ file: STORE_FILE, now: () => now });
  await reloaded.load();
  assert.equal(reloaded.get("dev-cat").desired.version, v2);
  assert.equal(reloaded.get("dev-cat").desired.entries[0].enabled, false);
  assert.equal(reloaded.get("dev-dog").divergenceStreak, 0);
});

// ── 2.x/3.x door stack over HTTP ─────────────────────────────────────────────

let relaySeen = [];
const doorEnv = { FLEET_INGEST_URL: "http://127.0.0.1:9/ingest", FLEET_INGEST_TOKEN: "relay-token" };
const fetchImpl = async (url, opts = {}) => {
  relaySeen.push({ url, body: JSON.parse(opts.body ?? "{}") });
  return { ok: true, status: 200 };
};
const reportDoor = createCellReportDoor({ appAuth, env: doorEnv, fetchImpl, now: () => now, machines: store });
const desiredDoor = createDesiredFleetDoor({ appAuth, machines: store });

const app = express();
app.use(express.json());
app.post("/api/gateway/cell-report", (req, res) => void reportDoor.handle(req, res));
app.get("/api/gateway/desired-fleet", (req, res) => void desiredDoor.handle(req, res));
registerFleetMachineRoutes({
  app,
  appAuth,
  machines: store,
  callerEmail: (req) => req.headers["x-test-email"] ?? null,
  isAdmin: (req) => req.headers["x-test-admin"] === "1",
});
let httpServer;
let base;
await new Promise((resolve) => {
  httpServer = app.listen(0, "127.0.0.1", resolve);
});
base = `http://127.0.0.1:${httpServer.address().port}`;

async function call(method, url, { headers = {}, body } = {}) {
  const r = await fetch(`${base}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

test("2.1 presence relays to ingest and touches liveness (legacy contract unchanged)", async () => {
  relaySeen = [];
  const r = await call("POST", "/api/gateway/cell-report", { headers: auth(DOG_TOKEN), body: { kind: "presence", payload: { state: "running", os: "darwin" } } });
  assert.equal(r.status, 202);
  assert.equal(r.json.relayed, true);
  assert.equal(relaySeen.length, 1);
  assert.equal(relaySeen[0].body.events[0].kind, "cell_presence");
  assert.equal(store.get("dev-dog").lastSeenAt, now);
});

test("2.2 cell_detail is store-only (never relayed) and deep-whitelisted", async () => {
  relaySeen = [];
  const r = await call("POST", "/api/gateway/cell-report", {
    headers: auth(DOG_TOKEN),
    body: {
      kind: "detail",
      payload: {
        at: now,
        capacity: { used: 2, cap: 4, unit: "runtime-group" },
        deployments: [{ agentPath: "p1/a1", packId: "p1", agentId: "a1", enabled: true, source: "cloud", prompt: "SECRET-CONTENT" }],
        agents: [{ key: "p1/a1", state: "serving", port: 8805, version: 3 }],
        merge: { desiredVersionSeen: 7, rejects: [{ agentPath: "p3/c1", code: "capacity_exceeded" }] },
        steward: { crashRestarts: 1, pullFailures: 0 },
        sessionTranscript: "USER-CONTENT-NEVER-LANDS",
      },
    },
  });
  assert.equal(r.status, 202);
  assert.equal(r.json.relayed, false);
  assert.equal(relaySeen.length, 0); // store-only: ops board contract untouched
  const detail = store.get("dev-dog").detail;
  assert.equal(detail.capacity.cap, 4);
  assert.equal(detail.deployments[0].source, "cloud");
  assert.equal("prompt" in detail.deployments[0], false, "content-shaped field stripped");
  assert.equal("sessionTranscript" in detail, false, "unknown top-level field stripped");
  assert.equal(detail.merge.desiredVersionSeen, 7);
  assert.equal(detail.steward.crashRestarts, 1);
});

test("2.3 reporting door answers 401 without a steward credential", async () => {
  const r1 = await call("POST", "/api/gateway/cell-report", { headers: { "content-type": "application/json" }, body: { kind: "presence", payload: { state: "running" } } });
  assert.equal(r1.status, 401);
  // An APP-kind device token is not a steward credential.
  const appToken = await pairSteward("dev-app2", "owner@test", "app");
  const r2 = await call("POST", "/api/gateway/cell-report", { headers: auth(appToken), body: { kind: "presence", payload: { state: "running" } } });
  assert.equal(r2.status, 401);
});

test("2.4 manifest numeric validation still holds", async () => {
  const r = await call("POST", "/api/gateway/cell-report", { headers: auth(DOG_TOKEN), body: { kind: "manifest", payload: { fleetCount: "three" } } });
  assert.equal(r.status, 400);
});

test("3.1 desired door is self-scoped and empty until recorded", async () => {
  // A steward that never had a desired set reads zeros.
  const FRESH_TOKEN = await pairSteward("dev-fresh", "fresh@test");
  const r0 = await call("GET", "/api/gateway/desired-fleet", { headers: auth(FRESH_TOKEN) });
  assert.equal(r0.status, 200);
  assert.deepEqual(r0.json, { version: 0, entries: [] });
  // dev-cat already has desired from 1.3 (version ≥ 2): its pull sees it.
  const r2 = await call("GET", "/api/gateway/desired-fleet", { headers: auth(CAT_TOKEN) });
  assert.equal(r2.json.version >= 2, true);
  assert.equal(r2.json.entries[0].packId, "p2");
  // dev-cat's desired never leaks to dev-dog's pull — the door reads the
  // token's did, and there is no device parameter to forge.
  const r3 = await call("GET", "/api/gateway/desired-fleet", { headers: auth(DOG_TOKEN) });
  assert.ok(!JSON.stringify(r3.json).includes("p2"));
});

test("3.2 desired door answers 401 without a steward credential", async () => {
  const r = await call("GET", "/api/gateway/desired-fleet", { headers: {} });
  assert.equal(r.status, 401);
});

// ── 4.x console routes ───────────────────────────────────────────────────────

// Both production entrypoints register these routes on an app WITHOUT a global
// body parser (gateway/index.js and server.js attach express.json per route),
// so a PUT that reaches the handler with req.body undefined 400s every write.
// The suite above mounts app.use(express.json()) and therefore hid it — this
// stack is bare on purpose (live walkthrough, 2026-10-29).
let bareServer;
let bareBase;
await new Promise((resolve) => {
  const bare = express();
  registerFleetMachineRoutes({
    app: bare,
    appAuth,
    machines: store,
    callerEmail: (req) => req.headers["x-test-email"] ?? null,
    isAdmin: () => false,
  });
  bareServer = bare.listen(0, "127.0.0.1", resolve);
});
bareBase = `http://127.0.0.1:${bareServer.address().port}`;

test("4.0 PUT desired parses its own body on an app with no global JSON parser", async () => {
  const r = await fetch(`${bareBase}/api/machines/dev-dog/desired`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-test-email": "owner@test" },
    body: JSON.stringify({ entries: [{ packId: "p1", agentId: "a1", enabled: true }] }),
  });
  const body = await r.json().catch(() => ({}));
  assert.equal(r.status, 200, `bare-mount PUT must succeed, got ${r.status} ${JSON.stringify(body)}`);
  assert.equal(body.desired.entries[0].packId, "p1");
  assert.equal(store.get("dev-dog").desired.entries[0].agentId, "a1");
});

test("4.1 roster requires an identity and lists steward pairings only", async () => {
  const unauth = await call("GET", "/api/machines");
  assert.equal(unauth.status, 401);
  const r = await call("GET", "/api/machines", { headers: { "x-test-email": "owner@test" } });
  assert.equal(r.status, 200);
  const ids = r.json.machines.map((m) => m.deviceId);
  assert.deepEqual(ids.sort(), ["dev-dog"]); // dev-app is kind=app — not a machine
  assert.equal(r.json.isAdminView, false);
});

test("4.2 ownership: another account's device is machine_not_found, detail never leaks", async () => {
  const r = await call("GET", "/api/machines/dev-cat", { headers: { "x-test-email": "owner@test" } });
  assert.equal(r.status, 404);
  const ok = await call("GET", "/api/machines/dev-cat", { headers: { "x-test-email": "other@test" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.desired.entries[0].packId, "p2");
});

test("4.3 PUT desired validates shape and bumps version", async () => {
  const bad = await call("PUT", "/api/machines/dev-dog/desired", { headers: { "x-test-email": "owner@test", "content-type": "application/json" }, body: { entries: [{ packId: "p1" }] } });
  assert.equal(bad.status, 400);
  const dup = await call("PUT", "/api/machines/dev-dog/desired", { headers: { "x-test-email": "owner@test", "content-type": "application/json" }, body: { entries: [{ packId: "p", agentId: "a" }, { packId: "p", agentId: "a" }] } });
  assert.equal(dup.status, 400);
  const before = store.get("dev-dog").desired?.version ?? 0;
  const ok = await call("PUT", "/api/machines/dev-dog/desired", { headers: { "x-test-email": "owner@test", "content-type": "application/json" }, body: { entries: [{ packId: "p1", agentId: "a1" }, { packId: "p1", agentId: "a2", enabled: false }] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.desired.version, before + 1);
  assert.equal(ok.json.desired.entries.length, 2);
  assert.equal(ok.json.desired.entries[1].enabled, false);
});

test("4.4 admin view reads across accounts from the store", async () => {
  const r = await call("GET", "/api/machines", { headers: { "x-test-admin": "1", "x-test-email": "admin@test" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.isAdminView, true);
  const ids = r.json.machines.map((m) => m.deviceId);
  assert.ok(ids.includes("dev-dog") && ids.includes("dev-cat"));
});

test("4.5 health derivation: silence, divergence streak, self-reported alerts", () => {
  const later = () => now + 61 * 60 * 1000;
  const silent = deriveMachineHealth({ lastSeenAt: now }, { now: later });
  assert.equal(silent.silence, "silent");
  assert.ok(silent.alerts.some((a) => a.kind === "silent"));
  const divergent = deriveMachineHealth({ lastSeenAt: now, divergenceStreak: 3 });
  assert.ok(divergent.alerts.some((a) => a.kind === "divergence"));
  const crashy = deriveMachineHealth({ lastSeenAt: now, detail: { steward: { crashRestarts: 4 } } });
  assert.ok(crashy.alerts.some((a) => a.kind === "crash_loop"));
  const healthy = deriveMachineHealth({ lastSeenAt: now, divergenceStreak: 0, detail: { steward: { crashRestarts: 0 } } });
  assert.equal(healthy.silence, "online");
  assert.deepEqual(healthy.alerts, []);
});

test("4.6 revoked pairing drops out of the roster automatically", async () => {
  await appAuth.revoke("owner@test", "dev-dog");
  const r = await call("GET", "/api/machines", { headers: { "x-test-email": "owner@test" } });
  assert.equal(r.json.machines.length, 0);
});

// ── 5.x history bookkeeping in the store (add-machine-lifecycle-console) ─────

test("5.1 first touch records one presence_flip; steady heartbeat adds nothing and writes nothing", async () => {
  await pairSteward("dev-h1", "owner@test");
  store.touch("dev-h1", { ownerEmail: "owner@test", presence: { state: "running" } });
  let row = store.get("dev-h1");
  assert.equal(row.history.length, 1);
  assert.equal(row.history[0].kind, "presence_flip");
  assert.equal(row.history[0].from, "never_reported");
  assert.equal(row.history[0].to, "online");
  for (let i = 0; i < 10; i++) store.touch("dev-h1", { presence: { state: "running" } });
  row = store.get("dev-h1");
  assert.equal(row.history.length, 1, "identical beats must add no events");
  await store.flush;
  const before = fs.readFileSync(STORE_FILE, "utf8");
  for (let i = 0; i < 10; i++) store.touch("dev-h1", { presence: { state: "running" } });
  await store.flush;
  assert.equal(fs.readFileSync(STORE_FILE, "utf8"), before, "heartbeat must not write");
});

test("5.2 detail transitions record merge_advance / rejects_flip / divergence_flip exactly once each", async () => {
  store.recordDesired("dev-h1", [{ packId: "p1", agentId: "a1", enabled: true }], { ownerEmail: "owner@test" });
  store.recordDetail("dev-h1", { at: now, deployments: [], merge: { desiredVersionSeen: 7 } });
  // First observation: consumed version null→7 and divergence opens (desired entry missing).
  let row = store.get("dev-h1");
  assert.ok(row.history.some((e) => e.kind === "merge_advance" && e.from === null && e.to === 7));
  assert.ok(row.history.some((e) => e.kind === "divergence_flip" && e.open === true));
  const marks = row.history.filter((e) => ["merge_advance", "rejects_flip", "divergence_flip"].includes(e.kind)).length;
  // Convergence: entry live, version advances, rejects appear then clear.
  store.recordDetail("dev-h1", { at: now, deployments: [{ agentPath: "p1/a1", packId: "p1", agentId: "a1", enabled: true, source: "cloud" }], merge: { desiredVersionSeen: 8, rejects: [{ agentPath: "p3/c1", code: "capacity_exceeded" }] } });
  store.recordDetail("dev-h1", { at: now, deployments: [{ agentPath: "p1/a1", packId: "p1", agentId: "a1", enabled: true, source: "cloud" }], merge: { desiredVersionSeen: 8, rejects: [] } });
  row = store.get("dev-h1");
  assert.ok(row.history.some((e) => e.kind === "merge_advance" && e.from === 7 && e.to === 8));
  assert.ok(row.history.some((e) => e.kind === "rejects_flip" && e.open === true && e.count === 1));
  assert.ok(row.history.some((e) => e.kind === "rejects_flip" && e.open === false));
  assert.ok(row.history.some((e) => e.kind === "divergence_flip" && e.open === false));
  // Replaying the identical detail snapshot: zero new signal events.
  const total = row.history.length;
  store.recordDetail("dev-h1", { at: now, deployments: [{ agentPath: "p1/a1", packId: "p1", agentId: "a1", enabled: true, source: "cloud" }], merge: { desiredVersionSeen: 8, rejects: [] } });
  assert.equal(store.get("dev-h1").history.length, total);
  assert.ok(total > marks);
});

test("5.3 desired edits record who/version/diff-count audits with no content fields", () => {
  store.recordDesired("dev-h1", [{ packId: "p1", agentId: "a1" }, { packId: "p1", agentId: "a2", enabled: false }], { ownerEmail: "audit@test" });
  store.recordDesired("dev-h1", [{ packId: "p1", agentId: "a1" }], { ownerEmail: "audit@test" });
  const events = store.get("dev-h1").history.filter((e) => e.kind === "desired_change");
  assert.equal(events[0].removed, 1, "newest first: the removal edit leads");
  assert.equal(events[0].who, "audit@test");
  assert.equal(events[0].version, 3);
  assert.equal(events[1].added, 1);
  assert.equal(events[1].toggled, 0);
  assert.equal(JSON.stringify(events).includes("prompt"), false);
});

test("5.4 a pre-history file loads with backfilled defaults and keeps working", async () => {
  const legacyFile = path.join(TMP, "legacy-machines.json");
  fs.writeFileSync(legacyFile, JSON.stringify({ machines: { "dev-old": { ownerEmail: "x@test", lastSeenAt: now, presence: { state: "running" }, detail: null, divergenceStreak: 0, desired: null } } }));
  const legacy = createFleetMachinesStore({ file: legacyFile, now: () => now });
  await legacy.load();
  const row = legacy.get("dev-old");
  assert.deepEqual(row.history, []);
  assert.equal(row.lastSignal, null);
  assert.equal(row.revokedAt, null);
  legacy.touch("dev-old", { presence: { state: "running" } });
  assert.equal(legacy.get("dev-old").history.length, 1, "first arrival after upgrade books the flip");
  await legacy.flush;
  const raw = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
  assert.ok(Array.isArray(raw.machines["dev-old"].history));
});

test("5.5 revoke clears desired, records unbound, filters list(), sweeps the row after 30 days", async () => {
  store.recordDesired("dev-h1", [{ packId: "p1", agentId: "a1" }], { ownerEmail: "owner@test" });
  store.revoke("dev-h1", { who: "owner@test" });
  const row = store.get("dev-h1");
  assert.ok(row.revokedAt);
  assert.equal(row.desired, null);
  assert.equal(row.divergenceStreak, 0);
  assert.equal(row.history[0].kind, "unbound");
  assert.equal(row.history[0].who, "owner@test");
  assert.ok(!store.list().some((r) => r.deviceId === "dev-h1"), "list() filters revoked rows");
  assert.ok(store.get("dev-h1"), "row retained for the retention window");
  await store.flush;
  const later = createFleetMachinesStore({ file: STORE_FILE, now: () => now + 31 * 24 * 3600 * 1000 });
  await later.load();
  assert.equal(later.get("dev-h1"), null, "row and history swept after 30 days");
  // A machine that reports again after revocation is live again (re-paired).
  store.touch("dev-h1", { ownerEmail: "owner@test", presence: { state: "running" } });
  assert.equal(store.get("dev-h1").revokedAt, null);
  assert.equal(store.get("dev-h1").desired, null, "revival inherits no expectation");
});

// ── 6.x history + unbind console routes ──────────────────────────────────────

test("6.1 history: owner reads newest-first with a bounded limit; other accounts get 404", async () => {
  const r = await call("GET", "/api/machines/dev-h1/history", { headers: { "x-test-email": "owner@test" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.history[0].kind, "unbound", "newest first: the last-recorded event leads");
  const lim = await call("GET", "/api/machines/dev-h1/history?limit=1", { headers: { "x-test-email": "owner@test" } });
  assert.equal(lim.status, 200);
  assert.equal(lim.json.history.length, 1);
  const other = await call("GET", "/api/machines/dev-h1/history", { headers: { "x-test-email": "other@test" } });
  assert.equal(other.status, 404);
});

test("6.2 revoked machine history stays readable for its owner within retention; admin reads across", async () => {
  // Production unbind flow (the DELETE route): binding and store row revoked
  // together. Only the retention rule (revokedAt + ownerEmail + 30d) keeps the
  // owner's access alive once the binding is gone.
  const H4 = await pairSteward("dev-h4", "owner@test");
  await call("POST", "/api/gateway/cell-report", { headers: auth(H4), body: { kind: "presence", payload: { state: "running" } } });
  const del = await call("DELETE", "/api/machines/dev-h4", { headers: { "x-test-email": "owner@test" } });
  assert.equal(del.status, 200);
  const owner = await call("GET", "/api/machines/dev-h4/history", { headers: { "x-test-email": "owner@test" } });
  assert.equal(owner.status, 200);
  assert.equal(owner.json.revokedAt != null, true);
  const admin = await call("GET", "/api/machines/dev-h4/history", { headers: { "x-test-admin": "1", "x-test-email": "admin@test" } });
  assert.equal(admin.status, 200);
  const other = await call("GET", "/api/machines/dev-h4/history", { headers: { "x-test-email": "other@test" } });
  assert.equal(other.status, 404);
});

test("6.3 DELETE unbinds: doors go dark, desired never inherited on re-pair, foreign 404", async () => {
  const H2 = await pairSteward("dev-h2", "owner@test");
  await call("POST", "/api/gateway/cell-report", { headers: auth(H2), body: { kind: "presence", payload: { state: "running" } } });
  store.recordDesired("dev-h2", [{ packId: "p9", agentId: "z", enabled: true }], { ownerEmail: "owner@test" });
  const del = await call("DELETE", "/api/machines/dev-h2", { headers: { "x-test-email": "owner@test" } });
  assert.equal(del.status, 200);
  const rep = await call("POST", "/api/gateway/cell-report", { headers: auth(H2), body: { kind: "presence", payload: { state: "running" } } });
  assert.equal(rep.status, 401, "reporting door cut");
  const pull = await call("GET", "/api/gateway/desired-fleet", { headers: auth(H2) });
  assert.equal(pull.status, 401, "pull door cut");
  // Same deviceId re-pairs: the desired set must NOT come back.
  const H2b = await pairSteward("dev-h2", "owner@test");
  const pull2 = await call("GET", "/api/gateway/desired-fleet", { headers: auth(H2b) });
  assert.deepEqual(pull2.json, { version: 0, entries: [] });
  assert.equal(store.get("dev-h2").history[0].kind, "unbound");
  const foreign = await call("DELETE", "/api/machines/dev-cat", { headers: { "x-test-email": "owner@test" } });
  assert.equal(foreign.status, 404);
});

// ── 7.x read-path silence booking ────────────────────────────────────────────

test("7.1 roster read books a silence flip exactly once, and the return flip rides touch", async () => {
  const t0 = Date.now();
  const silentStore = createFleetMachinesStore({ file: path.join(TMP, "silent-machines.json"), now: () => t0 });
  await silentStore.load();
  await pairSteward("dev-h3", "owner@test");
  silentStore.touch("dev-h3", { ownerEmail: "owner@test", presence: { state: "running" } });
  await silentStore.flush;
  const silenceApp = express();
  registerFleetMachineRoutes({
    app: silenceApp,
    appAuth,
    machines: silentStore,
    callerEmail: (req) => req.headers["x-test-email"] ?? null,
    isAdmin: () => false,
    now: () => t0 + 61 * 60 * 1000, // past the default silence window
  });
  const silenceServer = await new Promise((resolve) => {
    const srv = silenceApp.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const silenceBase = `http://127.0.0.1:${silenceServer.address().port}`;
  try {
    const flips = () => silentStore.get("dev-h3").history.filter((e) => e.kind === "presence_flip");
    await fetch(`${silenceBase}/api/machines`, { headers: { "x-test-email": "owner@test" } });
    assert.equal(flips().length, 2, "first-report flip + observed-silent flip");
    await fetch(`${silenceBase}/api/machines`, { headers: { "x-test-email": "owner@test" } });
    assert.equal(flips().length, 2, "second read must not duplicate");
    // The machine reports again: touch books the silent→online return flip.
    silentStore.touch("dev-h3", { presence: { state: "running" } });
    const events = flips();
    assert.equal(events.length, 3);
    assert.deepEqual(events[0], { at: t0, kind: "presence_flip", from: "silent", to: "online" });
  } finally {
    silenceServer.close();
  }
});

test("9.9 teardown closes the http server", () => {
  httpServer.close();
  bareServer.close();
  assert.ok(true);
});
