// Unit tests for agent fleets (agent-fleet-core).
//
// Covers the chain the spec pins:
//   - fleets-db: fleet/member CRUD, swap columns, unique-post lookup
//   - task-engine sourceTag passthrough: create/persist/reload round-trip,
//     legacy records untouched
//   - cron addJob agent(a2a)/sourceTag params + updateJob in-place rewrite
//     (id + session stable across cadence edits and target rebinds)
//   - reconcile: idempotence, cadence edit without orphans, cadence
//     withdrawal → passive, two-layer pause, vacancy pause, archived keeps
//     history and never re-materializes
//   - deriveMemberStatus: vacant/passive/paused/missing/on_duty precedence
//     and the evidence fields
//   - routes: owner scoping (403/401), validation 400s that leave no rows,
//     dense-cadence confirmation, unique post 409, cycle rejection, swap
//     preset rewrite + freshSession clearing, archive semantics, dissolve
//
// Run: node --test scripts/test-fleet-core.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-core-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const cron = await import("../cron.js");
const chatHistory = await import("../chat-history.js");
const { initDb } = await import("../db.js");
const engine = await import("../task-engine.js");
const {
  createFleetDatabase,
  setFleetDatabase,
} = await import("../server/routes/fleets-db.js");
const {
  reconcileFleet,
  reconcileAllFleets,
  deriveMemberStatus,
  cronPeriodMs,
  staleWindowMs,
} = await import("../server/fleet-reconcile.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

await initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
await engine.initTaskEngine({
  broadcast: () => {},
  runTurn: async () => ({ ok: true }),
  isBusy: () => false,
});

test.after(() => {
  // Armed node-schedule handles (hourly/daily cadences) keep the event loop
  // alive past the last test — cancel them so the runner can exit.
  cron.shutdown?.();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

function freshFleetDb() {
  const db = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
  setFleetDatabase(db);
  return db;
}

let fleetDb;
beforeEach(() => {
  fleetDb = freshFleetDb();
});

function fixtureFleet(db, { name = "一号舰队", state = "active", ownerEmail = "owner@test" } = {}) {
  return db.createFleet({ id: `fleet_${Math.random().toString(36).slice(2, 8)}`, name, ownerEmail, state });
}

const HOURLY = { cron: "0 * * * *", tz: "Asia/Shanghai", promptTemplate: "巡视并报数", enabled: true };

function fixtureMember(db, fleetId, over = {}) {
  return db.createMember({
    id: `m_${Math.random().toString(36).slice(2, 8)}`,
    fleetId,
    title: over.title ?? "电商部",
    parentId: over.parentId ?? null,
    targetKind: over.targetKind ?? "persona",
    targetId: over.targetId ?? "persona-a",
    kpiSlots: over.kpiSlots ?? [],
    cadence: over.cadence !== undefined ? over.cadence : HOURLY,
  });
}

// Fake target universe — mutable so vacancy scenarios flip entries.
function makeResolver(universe) {
  return (member) => {
    const u = universe[member.targetId];
    return { alive: !!u, label: u?.name ?? member.targetId, clusterName: u?.clusterName ?? null };
  };
}

const rosterFn = (id) => `r-${id}`;

function fleetTasks(fleetId) {
  return cron.listJobs().filter((j) => j?.sourceTag?.fleetId === fleetId);
}

// ── 1.1 fleets-db ───────────────────────────────────────────────────────────

test("fleets-db: fleet + member roundtrip, swap columns, unique-post lookup", () => {
  const fleet = fixtureFleet(fleetDb);
  assert.equal(fleet.state, "active");

  const member = fixtureMember(fleetDb, fleet.id, {
    kpiSlots: [{ key: "sales", label: "销售额", unit: "$" }],
  });
  assert.equal(member.cadence.cron, "0 * * * *");
  assert.equal(member.kpiSlots[0].key, "sales");
  assert.equal(member.parentId, null);

  const passive = fixtureMember(fleetDb, fleet.id, { title: "助理岗", cadence: null });
  assert.equal(passive.cadence, null);

  // Swap writes target_kind/target_id (ADR-0031's one mutable ref).
  const swapped = fleetDb.updateMember(member.id, { targetKind: "persona", targetId: "persona-b" });
  assert.equal(swapped.targetId, "persona-b");
  assert.equal(swapped.cadence.cron, member.cadence.cron, "cadence untouched by swap");

  // Unique-post lookup: hit + self-exclusion.
  const hit = fleetDb.findPostByTarget("persona", "persona-b");
  assert.equal(hit.member.id, member.id);
  assert.equal(fleetDb.findPostByTarget("persona", "persona-b", { excludeMemberId: member.id }), null);
  assert.equal(fleetDb.findPostByTarget("persona", "ghost"), null);

  // Archived/dissolved fleets release their incumbents (prod 2026-10-23).
  assert.notEqual(fleetDb.findPostByTarget("persona", "persona-b"), null, "live fleet holds the post");
  fleetDb.updateFleet(fleet.id, { state: "archived" });
  assert.equal(fleetDb.findPostByTarget("persona", "persona-b"), null, "archived fleet no longer squats the agent");

  // Member deletion + fleet state update.
  assert.equal(fleetDb.deleteMember(passive.id), true);
  assert.equal(fleetDb.listMembers(fleet.id).length, 1);
  assert.equal(fleetDb.updateFleet(fleet.id, { state: "paused" }).state, "paused");
});

// ── 1.2 sourceTag passthrough ───────────────────────────────────────────────

test("engine: sourceTag rides create/list and survives a reload; legacy rows read null", async () => {
  const job = await cron.addJob({
    cron: "0 * * * *",
    prompt: "巡视",
    preset: "persona-a",
    sourceTag: { fleetId: "fleet_x", memberId: "m_x" },
  });
  assert.deepEqual(job.sourceTag, { fleetId: "fleet_x", memberId: "m_x" });
  assert.deepEqual(
    cron.listJobs().find((j) => j.id === job.id).sourceTag,
    { fleetId: "fleet_x", memberId: "m_x" },
  );

  // Reload from disk: the write chain must have persisted the tag.
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: async () => ({ ok: true }),
    isBusy: () => false,
  });
  const reloaded = cron.getJob(job.id);
  assert.deepEqual(reloaded.sourceTag, { fleetId: "fleet_x", memberId: "m_x" });

  // Legacy record without a tag: null, and nothing else about it changes.
  const legacyId = "job_legacy_1";
  const legacy = {
    id: legacyId,
    trigger: "schedule",
    type: "recurring",
    cron: "0 * * * *",
    when: null,
    prompt: "旧任务",
    preset: "persona-old",
    targetType: "persona",
    sessionId: `cron-${legacyId}`,
    sessionTitle: null,
    tz: null,
    status: "scheduled",
    paused: false,
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null,
    missed: 0,
    history: [],
  };
  const jobsFile = path.join(tmpRoot, "jobs.json");
  const onDisk = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
  fs.writeFileSync(jobsFile, JSON.stringify([...onDisk.filter((t) => t.id !== legacyId), legacy]));
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: async () => ({ ok: true }),
    isBusy: () => false,
  });
  assert.equal(cron.getJob(legacyId).sourceTag, null);
  assert.equal(cron.getJob(legacyId).prompt, "旧任务");
  // And the tagged task survived the same reload.
  assert.deepEqual(cron.getJob(job.id)?.sourceTag, { fleetId: "fleet_x", memberId: "m_x" });
});

test("cron: addJob agent target (a2a) + exclusivity; updateJob rebinds in place", async () => {
  const a2aJob = await cron.addJob({
    cron: "0 * * * *",
    prompt: "远端巡视",
    agent: "a2a-x",
    sourceTag: { fleetId: "f1", memberId: "m1" },
  });
  assert.equal(a2aJob.target.type, "a2a");
  assert.equal(a2aJob.preset, "a2a-x");

  await assert.rejects(
    () => cron.addJob({ cron: "0 * * * *", prompt: "x", preset: "p", agent: "a2a-x" }),
    /not both/,
  );
  await assert.rejects(
    () => cron.addJob({ cron: "0 * * * *", prompt: "x", clusterId: "c1", agent: "a2a-x" }),
    /not both/,
  );

  // Cadence edit in place: id, session, history preserved; cron changed.
  const daily = await cron.updateJob(a2aJob.id, { cron: "0 9 * * *", tz: "UTC" });
  assert.equal(daily.id, a2aJob.id);
  assert.equal(daily.sessionId, a2aJob.sessionId);
  assert.equal(daily.cron, "0 9 * * *");

  // Target rebind persona → cluster: clusterId set, targetType flipped.
  const asCluster = await cron.updateJob(a2aJob.id, { clusterId: "dyn_c", clusterName: "集群一" });
  assert.equal(asCluster.target.type, "cluster");
  assert.equal(asCluster.clusterId, "dyn_c");
  assert.equal(asCluster.clusterName, "集群一");

  // And cluster → persona clears the cluster residue.
  const asPersona = await cron.updateJob(a2aJob.id, { preset: "persona-z" });
  assert.equal(asPersona.target.type, "persona");
  assert.equal(asPersona.clusterId, null);

  // Invalid cron on update refuses.
  await assert.rejects(() => cron.updateJob(a2aJob.id, { cron: "not a cron" }), /invalid cron/);
});

// ── 1.3 reconcile ───────────────────────────────────────────────────────────

test("reconcile: materializes once, second pass is a no-op", async () => {
  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id);
  const resolver = makeResolver({ "persona-a": { name: "A" } });

  const first = await reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  assert.equal(first.created.length, 1);
  const task = fleetTasks(fleet.id)[0];
  assert.deepEqual(task.sourceTag, { fleetId: fleet.id, memberId: member.id });
  assert.equal(task.prompt, HOURLY.promptTemplate);
  assert.equal(task.sessionTitle, "一号舰队 · 电商部");
  assert.equal(task.preset, "r-persona-a", "catalog id → roster preset id");

  const second = await reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  assert.deepEqual(second, { created: [], updated: [], paused: [], resumed: [], removed: [] });
});

test("reconcile: cadence edit rewrites the SAME task (no orphan); withdrawal removes it", async () => {
  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id);
  const resolver = makeResolver({ "persona-a": {} });
  const run = () => reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  await run();
  const before = fleetTasks(fleet.id)[0];

  fleetDb.updateMember(member.id, { cadence: { cron: "0 9 * * *", tz: "UTC", promptTemplate: "晨报", enabled: true } });
  const out = await run();
  assert.equal(out.updated.length, 1);
  const after = fleetTasks(fleet.id)[0];
  assert.equal(after.id, before.id, "in-place rewrite, task id stable");
  assert.equal(after.sessionId, before.sessionId, "dedicated session continuity");
  assert.equal(after.cron, "0 9 * * *");
  assert.equal(after.prompt, "晨报");
  assert.equal(fleetTasks(fleet.id).length, 1, "no orphan task");

  // Withdraw the cadence entirely → passive post, task removed.
  fleetDb.updateMember(member.id, { cadence: null });
  const withdrawn = await run();
  assert.equal(withdrawn.removed.length, 1);
  assert.equal(fleetTasks(fleet.id).length, 0);
});

test("reconcile: the orphan sweep spares one-shot manual turns (event wakes survive)", async () => {
  // Production walk 2026-11-03: a queued event-wake task (trigger=manual,
  // origin.fleet → sourceTag) was swept as a "cadence-withdrawn orphan" by the
  // next fleet PATCH — the sweep manages materialized rhythm tasks only.
  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id, { title: "事件岗", cadence: null });
  const resolver = makeResolver({ "persona-a": {} });

  // A one-shot manual turn tagged to the fleet (the event-wake shape).
  const wake = engine.createManualTask({
    prompt: "【事件唤醒】外部信号源 bot:helper 收到来自「走查」的消息",
    persona: "r-persona-a",
    sessionTitle: "事件 · 事件岗",
    origin: { fleet: { fleetId: fleet.id, memberId: member.id, depth: 0 }, event: { botId: "helper", chatKey: "c" } },
  });

  const out = await reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  assert.deepEqual(out.removed, [], "a queued one-shot manual turn is not an orphan");
  assert.equal(engine.getTask(wake.id).state !== undefined, true, "the wake task survives reconcile");
  assert.equal(fleetTasks(fleet.id).some((t) => t.id === wake.id), true);

  // The rhythm side keeps its own semantics: a passive post materializes nothing.
  assert.deepEqual(out.created, []);
});

test("reconcile: passive posts never materialize", async () => {
  const fleet = fixtureFleet(fleetDb);
  fixtureMember(fleetDb, fleet.id, { title: "助理岗", cadence: null });
  const out = await reconcileFleet({
    fleetId: fleet.id, db: fleetDb, cronApi: cron,
    resolveTarget: makeResolver({ "persona-a": {} }), rosterPresetId: rosterFn,
  });
  assert.deepEqual(out, { created: [], updated: [], paused: [], resumed: [], removed: [] });
  assert.equal(fleetTasks(fleet.id).length, 0);
});

test("reconcile: two-layer pause — member pause survives fleet resume", async () => {
  const fleet = fixtureFleet(fleetDb);
  const m1 = fixtureMember(fleetDb, fleet.id, { title: "甲", targetId: "persona-a" });
  const m2 = fixtureMember(fleetDb, fleet.id, { title: "乙", targetId: "persona-b" });
  const resolver = makeResolver({ "persona-a": {}, "persona-b": {} });
  const run = () => reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  await run();

  // Fleet pause → both tasks paused; resume → both back.
  fleetDb.updateFleet(fleet.id, { state: "paused" });
  let out = await run();
  assert.equal(out.paused.length, 2);
  fleetDb.updateFleet(fleet.id, { state: "active" });
  out = await run();
  assert.equal(out.resumed.length, 2);

  // Member-level pause on m2, then a fleet pause+resume cycle: m2 stays parked.
  fleetDb.updateMember(m2.id, { cadence: { ...HOURLY, enabled: false } });
  out = await run();
  assert.equal(out.paused.length, 1);
  fleetDb.updateFleet(fleet.id, { state: "paused" });
  await run();
  fleetDb.updateFleet(fleet.id, { state: "active" });
  out = await run();
  assert.equal(out.resumed.length, 1, "only m1 resumes");
  const tasks = fleetTasks(fleet.id);
  const t1 = tasks.find((t) => t.sourceTag.memberId === m1.id);
  const t2 = tasks.find((t) => t.sourceTag.memberId === m2.id);
  assert.equal(t1.paused, false);
  assert.equal(t2.paused, true, "member pause outlives the fleet cycle");
});

test("reconcile: a vacant post's task is parked, restaff re-arms it", async () => {
  const universe = { "persona-a": {} };
  const fleet = fixtureFleet(fleetDb);
  fixtureMember(fleetDb, fleet.id);
  const resolver = makeResolver(universe);
  const run = () => reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  await run();

  delete universe["persona-a"]; // persona deleted → post vacant
  let out = await run();
  assert.equal(out.paused.length, 1, "vacancy parks the materialized task");

  universe["persona-b"] = {}; // restaff to a live persona
  fleetDb.updateMember(fleetTasks(fleet.id)[0].sourceTag.memberId, { targetKind: "persona", targetId: "persona-b" });
  out = await run();
  assert.equal(out.resumed.length, 1);
  assert.equal(out.updated.length >= 0, true);
  assert.equal(fleetTasks(fleet.id)[0].preset, "r-persona-b");
});

test("reconcile: archived fleets never re-materialize; archive parks all", async () => {
  const fleet = fixtureFleet(fleetDb);
  fixtureMember(fleetDb, fleet.id);
  const resolver = makeResolver({ "persona-a": {} });
  const run = () => reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  await run();
  assert.equal(fleetTasks(fleet.id).length, 1);

  fleetDb.updateFleet(fleet.id, { state: "archived" });
  let out = await run();
  assert.equal(out.paused.length, 1, "archive parks the task, keeps it for history");

  // A member added behind the fleet's back (db-level) materializes nothing.
  fixtureMember(fleetDb, fleet.id, { title: "幽灵岗", targetId: "persona-b" });
  out = await run();
  assert.equal(out.created.length, 0);
});

test("reconcileAllFleets: converges every fleet, isolates per-fleet errors", async () => {
  const f1 = fixtureFleet(fleetDb, { name: "甲队" });
  const f2 = fixtureFleet(fleetDb, { name: "乙队" });
  fixtureMember(fleetDb, f1.id);
  fixtureMember(fleetDb, f2.id, { targetId: "persona-b" });
  const resolver = makeResolver({ "persona-a": {}, "persona-b": {} });
  const results = await reconcileAllFleets({ db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  assert.equal(results.length, 2);
  assert.equal(results[0].created.length + results[1].created.length, 2);
});

// ── derived status ──────────────────────────────────────────────────────────

test("derive: precedence + evidence", () => {
  const fleet = { state: "active" };
  const now = Date.now();

  // vacant wins even with a healthy cadence
  let d = deriveMemberStatus({ member: { cadence: HOURLY }, fleet, task: null, targetAlive: false, now });
  assert.equal(d.status, "vacant");

  // passive
  d = deriveMemberStatus({ member: { cadence: null }, fleet, task: null, targetAlive: true, now });
  assert.equal(d.status, "passive");

  // paused: fleet layer
  d = deriveMemberStatus({ member: { cadence: HOURLY }, fleet: { state: "paused" }, task: null, targetAlive: true, now });
  assert.equal(d.status, "paused");
  // paused: member layer
  d = deriveMemberStatus({ member: { cadence: { ...HOURLY, enabled: false } }, fleet, task: null, targetAlive: true, now });
  assert.equal(d.status, "paused");

  // missing: no materialized task at all
  d = deriveMemberStatus({ member: { cadence: HOURLY }, fleet, task: null, targetAlive: true, now });
  assert.equal(d.status, "missing");

  // missing: last execution beyond the window (hourly → 6h floor)
  const stale = { lastRun: new Date(now - 7 * 3600_000).toISOString(), nextRun: null, createdAt: new Date(now - 7200_000).toISOString() };
  d = deriveMemberStatus({ member: { cadence: HOURLY }, fleet, task: stale, targetAlive: true, now });
  assert.equal(d.status, "missing");
  assert.equal(d.evidence.staleWindowMs, 6 * 3600_000);

  // missing: never ran and the window passed since materialization
  d = deriveMemberStatus({
    member: { cadence: HOURLY }, fleet, targetAlive: true, now,
    task: { lastRun: null, nextRun: null, createdAt: new Date(now - 7 * 3600_000).toISOString() },
  });
  assert.equal(d.status, "missing");

  // on_duty: recent execution
  d = deriveMemberStatus({
    member: { cadence: HOURLY }, fleet, targetAlive: true, now,
    task: { lastRun: new Date(now - 1800_000).toISOString(), nextRun: new Date(now + 1800_000).toISOString(), createdAt: new Date(now - 7200_000).toISOString() },
  });
  assert.equal(d.status, "on_duty");
  assert.ok(d.evidence.nextRunAt);

  // on_duty: awaiting the first scheduled run
  d = deriveMemberStatus({
    member: { cadence: HOURLY }, fleet, targetAlive: true, now,
    task: { lastRun: null, nextRun: new Date(now + 1800_000).toISOString(), createdAt: new Date(now - 600_000).toISOString() },
  });
  assert.equal(d.status, "on_duty");
});

test("schedule math: period + floor", () => {
  assert.equal(cronPeriodMs("0 * * * *", null), 3600_000);
  assert.equal(cronPeriodMs("0 9 * * *", null), 24 * 3600_000);
  assert.equal(cronPeriodMs("bogus", null), null);
  assert.equal(staleWindowMs("0 * * * *", null), 6 * 3600_000, "floor at 6h");
  assert.equal(staleWindowMs("0 */6 * * *", null), 12 * 3600_000, "2× period above the floor");
});

test("schedule math: memoized period keeps its value and its null", () => {
  // Memoized per (cron, tz, day): the roster derives a stale window per member
  // and the derivation asks again, so an uncached parse cost ~40ms per call
  // with a tz (a 60-post fleet paid seconds per read). The cache must not
  // change the answer — including the null for an unparseable expression.
  const tz = "Asia/Shanghai";
  const first = cronPeriodMs("0 9 * * *", tz);
  const second = cronPeriodMs("0 9 * * *", tz);
  assert.equal(first, 24 * 3600_000);
  assert.equal(second, first, "the cached value equals the computed one");
  assert.equal(cronPeriodMs("not a cron", tz), null);
  assert.equal(cronPeriodMs("not a cron", tz), null, "a null result is cached too");
  // A distinct tz is a distinct key (no cross-timezone bleed).
  assert.equal(typeof cronPeriodMs("0 9 * * *", "UTC"), "number");
});

// ── routes ──────────────────────────────────────────────────────────────────

async function startServer(ctx, { userHeader = null } = {}) {
  const app = express();
  app.use(express.json());
  if (userHeader) {
    app.use((req, _res, next) => {
      const u = req.headers["x-test-user"];
      if (u) req.user = { email: u, groups: [] };
      next();
    });
  }
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, headers = {}) =>
    fetch(`${base}${p}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { server, call };
}

test("routes: CRUD + validation + owner scoping", async () => {
  const universe = {
    "persona-a": { name: "甲" },
    "persona-b": { name: "乙" },
    "persona-c": { name: "丙" },
    "persona-d": { name: "丁" },
    "cluster-1": { name: "集群一", clusterName: "集群一" },
    "a2a-x": { name: "远端" },
  };
  const { server, call } = await startServer({
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: makeResolver(universe),
  }, { userHeader: true });

  try {
    // 401 with auth-on and no user identity.
    const strict = await startServer({ authEnabled: true, fleetTargetResolver: makeResolver(universe) }, { userHeader: true });
    try {
      const anon = await strict.call("GET", "/api/fleets");
      assert.equal(anon.status, 401);
    } finally {
      strict.server.close();
    }

    // create: 400 on missing name, 201 on valid
    assert.equal((await call("POST", "/api/fleets", {})).status, 400);
    const created = await call("POST", "/api/fleets", { name: "一号舰队" });
    assert.equal(created.status, 201);
    const fleetId = created.body.fleet.id;

    // member validation: bad target / bad cron / missing title → 400, nothing lands
    assert.equal((await call("POST", `/api/fleets/${fleetId}/members`, { title: "X", targetKind: "persona", targetId: "ghost" })).status, 400);
    assert.equal((await call("POST", `/api/fleets/${fleetId}/members`, { title: "X", targetKind: "persona", targetId: "persona-a", cadence: { cron: "nope", promptTemplate: "p" } })).status, 400);
    assert.equal((await call("POST", `/api/fleets/${fleetId}/members`, { targetKind: "persona", targetId: "persona-a" })).status, 400);
    let detail = await call("GET", `/api/fleets/${fleetId}`);
    assert.equal(detail.body.members.length, 0, "rejected writes leave no rows");

    // dense cadence gate (<10min): 400 without confirm, 201 with
    const dense = { cron: "*/5 * * * *", promptTemplate: "高频巡视" };
    let r = await call("POST", `/api/fleets/${fleetId}/members`, { title: "电商部", targetKind: "persona", targetId: "persona-a", cadence: dense });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "cadence_confirmation_required");
    r = await call("POST", `/api/fleets/${fleetId}/members`, { title: "电商部", targetKind: "persona", targetId: "persona-a", cadence: dense, confirmed: true });
    assert.equal(r.status, 201);
    const ceo = r.body.member;
    assert.equal(ceo.cadence.cron, "*/5 * * * *");

    // unique post: persona-a again → 409 naming the existing post
    r = await call("POST", `/api/fleets/${fleetId}/members`, { title: "影子岗", targetKind: "persona", targetId: "persona-a", cadence: HOURLY });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /电商部/);
    // a2a targets are exempt — two posts on the same a2a entry is legal
    r = await call("POST", `/api/fleets/${fleetId}/members`, { title: "外联一", targetKind: "a2a", targetId: "a2a-x", cadence: HOURLY });
    assert.equal(r.status, 201);
    r = await call("POST", `/api/fleets/${fleetId}/members`, { title: "外联二", targetKind: "a2a", targetId: "a2a-x", cadence: HOURLY });
    assert.equal(r.status, 201);
    // passive cluster post
    r = await call("POST", `/api/fleets/${fleetId}/members`, { title: "集群岗", targetKind: "cluster", targetId: "cluster-1" });
    assert.equal(r.status, 201);
    const clusterPost = r.body.member;

    detail = await call("GET", `/api/fleets/${fleetId}`);
    assert.equal(detail.body.members.length, 4);
    const passiveView = detail.body.members.find((m) => m.id === clusterPost.id);
    assert.equal(passiveView.status, "passive");

    // org tree: parent then cycle rejection
    const ceoId = ceo.id;
    r = await call("PATCH", `/api/fleets/${fleetId}/members/${detail.body.members.find((m) => m.title === "外联一").id}`, { parentId: ceoId });
    assert.equal(r.status, 200);
    r = await call("PATCH", `/api/fleets/${fleetId}/members/${ceoId}`, { parentId: detail.body.members.find((m) => m.title === "外联一").id });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /cycle/);

    // swap: preset rewritten on the SAME task; freshSession clears the session
    const taskBefore = fleetTasks(fleetId).find((t) => t.sourceTag.memberId === ceoId);
    chatHistory.recordMessage(taskBefore.sessionId, "user", "第一任的对话");
    assert.ok((await chatHistory.listSessions()).some((s) => s.id === taskBefore.sessionId));

    r = await call("POST", `/api/fleets/${fleetId}/members/${ceoId}/swap`, { targetKind: "persona", targetId: "persona-b" });
    assert.equal(r.status, 200);
    const taskAfter = fleetTasks(fleetId).find((t) => t.sourceTag.memberId === ceoId);
    assert.equal(taskAfter.id, taskBefore.id);
    assert.equal(taskAfter.sessionId, taskBefore.sessionId);
    assert.equal(taskAfter.target.ref, "persona-b");
    assert.ok((await chatHistory.listSessions()).some((s) => s.id === taskBefore.sessionId), "default swap keeps the conversation");

    r = await call("POST", `/api/fleets/${fleetId}/members/${ceoId}/swap`, { targetKind: "persona", targetId: "persona-c", freshSession: true });
    assert.equal(r.status, 200);
    assert.ok(!(await chatHistory.listSessions()).some((s) => s.id === taskBefore.sessionId), "freshSession cleared the dedicated session");
    assert.equal(fleetTasks(fleetId).find((t) => t.sourceTag.memberId === ceoId).sessionId, taskBefore.sessionId, "session id itself is stable");

    // swap onto an on-duty incumbent (ceo holds persona-c) → 409
    r = await call("POST", `/api/fleets/${fleetId}/members/${clusterPost.id}/swap`, { targetKind: "persona", targetId: "persona-c" });
    assert.equal(r.status, 409);

    // two-layer pause over the API
    const memberB = detail.body.members.find((m) => m.title === "外联一");
    r = await call("PATCH", `/api/fleets/${fleetId}`, { state: "paused" });
    assert.equal(r.status, 200);
    assert.equal(fleetTasks(fleetId).every((t) => t.paused === true || t.sourceTag.memberId === clusterPost.id), true);
    await call("PATCH", `/api/fleets/${fleetId}`, { state: "active" });
    r = await call("POST", `/api/fleets/${fleetId}/members/${memberB.id}/pause`);
    assert.equal(r.status, 200);
    await call("PATCH", `/api/fleets/${fleetId}`, { state: "paused" });
    await call("PATCH", `/api/fleets/${fleetId}`, { state: "active" });
    assert.equal(fleetTasks(fleetId).find((t) => t.sourceTag.memberId === memberB.id).paused, true, "member pause survives fleet resume");
    assert.equal(fleetTasks(fleetId).find((t) => t.sourceTag.memberId === ceoId).paused, false);

    // vacancy derived at read time
    delete universe["persona-c"];
    detail = await call("GET", `/api/fleets/${fleetId}`);
    assert.equal(detail.body.members.find((m) => m.id === ceoId).status, "vacant");

    // cross-owner: other user sees nothing and cannot write
    let otherList = await call("GET", "/api/fleets", undefined, { "x-test-user": "other@test" });
    assert.equal(otherList.status, 200);
    assert.equal(otherList.body.fleets.length, 0);
    r = await call("PATCH", `/api/fleets/${fleetId}`, { name: "改名" }, { "x-test-user": "other@test" });
    assert.equal(r.status, 403);

    // archive: terminal, freezes cadence writes, dissolve removes tasks
    r = await call("PATCH", `/api/fleets/${fleetId}`, { state: "archived" });
    assert.equal(r.status, 200);
    r = await call("POST", `/api/fleets/${fleetId}/members`, { title: "迟到岗", targetKind: "persona", targetId: "persona-d" });
    assert.equal(r.status, 409);
    r = await call("PATCH", `/api/fleets/${fleetId}/members/${ceoId}`, { cadence: HOURLY });
    assert.equal(r.status, 409);
    assert.equal(fleetTasks(fleetId).length, 3, "archived keeps tasks parked for history");
    r = await call("PATCH", `/api/fleets/${fleetId}`, { state: "active" });
    assert.equal(r.status, 409, "archived is terminal");
    r = await call("DELETE", `/api/fleets/${fleetId}`);
    assert.equal(r.status, 200);
    assert.equal(fleetTasks(fleetId).length, 0, "dissolve removes materialized tasks");
    detail = await call("GET", `/api/fleets/${fleetId}`);
    assert.equal(detail.body.fleet.state, "archived");
    assert.equal(detail.body.members.length, 4, "history rows survive dissolution");
  } finally {
    server.close();
  }
});

// ── post model (add-fleet-post-model) ───────────────────────────────────────

const { resolveModelChain, fleetModelChoiceError } = await import("../server/fleet-model.js");
const { fleetModelFor } = await import("../server/fleet-reports.js");
const { attachCronRunner } = await import("../server/cron-runner.js");

test("post model: resolution chain + write gates (pure)", () => {
  // order + dedupe: an identical fallback is not a second hop
  let r = resolveModelChain({ model: "a", fallbackModel: "a", fleetDefault: "b", cellDefault: "c", roster: ["a", "b", "c"] });
  assert.equal(r.effective, "a");
  assert.equal(r.notices.length, 0);

  // declared but roster-missing: fall through AND name every dead hop
  r = resolveModelChain({ model: "x", fallbackModel: "y", fleetDefault: "b", cellDefault: "c", roster: ["b"] });
  assert.equal(r.effective, "b");
  assert.equal(r.notices.length, 2);
  assert.match(r.notices[0], /post model 'x'/);
  assert.match(r.notices[1], /post fallback model 'y'/);

  // undeclared hops inherit silently — no notice for a null
  r = resolveModelChain({ fleetDefault: "b", roster: ["b"] });
  assert.equal(r.effective, "b");
  assert.equal(r.notices.length, 0);

  // known-empty roster refuses everything: honest null, not a guess
  r = resolveModelChain({ model: "x", roster: [] });
  assert.equal(r.effective, null);
  assert.equal(r.candidates.length, 0);

  // unknown roster degrades open (first declared hop wins)
  r = resolveModelChain({ model: "x", roster: null });
  assert.equal(r.effective, "x");

  // write gates: shape → roster, error names the violated gate
  assert.match(fleetModelChoiceError({ model: "bad id!" }), /not a valid model identifier/);
  assert.match(fleetModelChoiceError({ model: "ghost", roster: ["a"] }), /roster/);
  assert.equal(fleetModelChoiceError({ model: "a", roster: ["a"] }), null);
  assert.equal(fleetModelChoiceError({ model: "a", roster: null }), null, "unknown roster leaves the gate open");
});

test("routes: post-model write gates, inheritance, drift visibility, report bridge", async () => {
  const universe = {
    "persona-a": { name: "甲" },
    "persona-b": { name: "乙" },
    "cluster-1": { name: "集群一", clusterName: "集群一" },
    "a2a-x": { name: "远端" },
  };
  const pendingNotices = new Map();
  const ctx = {
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: makeResolver(universe),
    dshModels: [{ id: "cheap-m" }, { id: "strong-m" }, { id: "boot-m" }],
    bootModel: { id: "boot-m" },
    currentPreset: "persona-a",
    recordFleetModelNotices: (id, n) => (n?.length ? pendingNotices.set(id, n) : pendingNotices.delete(id)),
    takeFleetModelNotices: (id) => {
      const n = pendingNotices.get(id) ?? [];
      pendingNotices.delete(id);
      return n;
    },
  };
  const { server, call } = await startServer(ctx);
  try {
    const created = await call("POST", "/api/fleets", { name: "模型舰队" });
    const fid = created.body.fleet.id;

    // fleet default model: valid lands, ghost names the gate
    let r = await call("PATCH", `/api/fleets/${fid}`, { defaultModel: "strong-m" });
    assert.equal(r.status, 200);
    assert.equal(r.body.fleet.defaultModel, "strong-m");
    r = await call("PATCH", `/api/fleets/${fid}`, { defaultModel: "ghost-m" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /roster/);

    // member create with a model: echoed, effective = declared
    r = await call("POST", `/api/fleets/${fid}/members`, { title: "巡线岗", targetKind: "persona", targetId: "persona-a", model: "cheap-m" });
    assert.equal(r.status, 201);
    const patrol = r.body.member;
    assert.equal(patrol.model, "cheap-m");
    assert.equal(patrol.effectiveModel, "cheap-m");
    assert.equal(patrol.modelNotice, null);

    // shape + roster gates, and the fallback⇒primary constraint
    assert.match((await call("POST", `/api/fleets/${fid}/members`, { title: "X", targetKind: "persona", targetId: "persona-b", model: "bad id!" })).body.error, /not a valid model identifier/);
    assert.match((await call("POST", `/api/fleets/${fid}/members`, { title: "X", targetKind: "persona", targetId: "persona-b", model: "ghost-m" })).body.error, /roster/);
    assert.match((await call("POST", `/api/fleets/${fid}/members`, { title: "X", targetKind: "persona", targetId: "persona-b", fallbackModel: "strong-m" })).body.error, /fallbackModel requires model/);

    // non-persona posts refuse a model outright
    assert.match((await call("POST", `/api/fleets/${fid}/members`, { title: "远端岗", targetKind: "a2a", targetId: "a2a-x", model: "cheap-m" })).body.error, /only persona posts/);
    assert.match((await call("POST", `/api/fleets/${fid}/members`, { title: "集群岗", targetKind: "cluster", targetId: "cluster-1", model: "cheap-m" })).body.error, /only persona posts/);

    // inheritance: an undeclared post's effective model is the fleet default
    r = await call("POST", `/api/fleets/${fid}/members`, { title: "内容岗", targetKind: "persona", targetId: "persona-b", cadence: HOURLY });
    const content = r.body.member;
    assert.equal(content.model, null);
    assert.equal(content.effectiveModel, "strong-m", "undeclared post inherits the fleet default");

    // PATCH semantics: clearing model with a fallback hanging on is refused;
    // clearing both lands; then re-set pair is fine
    await call("PATCH", `/api/fleets/${fid}/members/${patrol.id}`, { fallbackModel: "strong-m" });
    r = await call("PATCH", `/api/fleets/${fid}/members/${patrol.id}`, { model: null });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /fallbackModel requires model/);
    r = await call("PATCH", `/api/fleets/${fid}/members/${patrol.id}`, { model: null, fallbackModel: null });
    assert.equal(r.status, 200);
    assert.equal(r.body.member.model, null);
    assert.equal(r.body.member.fallbackModel, null);
    r = await call("PATCH", `/api/fleets/${fid}/members/${patrol.id}`, { model: "cheap-m", fallbackModel: "strong-m" });
    assert.equal(r.body.member.effectiveModel, "cheap-m");

    // roster drift on the read face: the declared hop dies, the view shows
    // the fall-through landing AND names the dead hop. The fallback IS the
    // fleet default here, so it is alive — one notice, not two.
    ctx.dshModels = [{ id: "strong-m" }, { id: "boot-m" }];
    let detail = await call("GET", `/api/fleets/${fid}`);
    const drifted = detail.body.members.find((m) => m.id === patrol.id);
    assert.equal(drifted.effectiveModel, "strong-m", "falls to the fleet default");
    assert.match(drifted.modelNotice, /post model 'cheap-m'/);

    // report bridge: a notice recorded for this member rides the next report
    // as a blocker, prepended to the agent's own
    ctx.dshModels = [{ id: "cheap-m" }, { id: "strong-m" }, { id: "boot-m" }];
    pendingNotices.set(patrol.id, ["declared post model 'cheap-m' is not in the runner's model roster — falling through"]);
    r = await call("POST", "/api/fleets/report", { summary: "正常报数", blockers: ["我自己的阻塞"] });
    assert.equal(r.status, 201);
    detail = await call("GET", `/api/fleets/${fid}`);
    const reported = detail.body.members.find((m) => m.id === patrol.id);
    assert.deepEqual(reported.reportTimeline[0].blockers, [
      "declared post model 'cheap-m' is not in the runner's model roster — falling through",
      "我自己的阻塞",
    ]);
    // one-shot: the next report does not repeat the notice
    r = await call("POST", "/api/fleets/report", { summary: "再报一次" });
    assert.equal(r.status, 201);
    detail = await call("GET", `/api/fleets/${fid}`);
    const again = detail.body.members.find((m) => m.id === patrol.id);
    assert.deepEqual(again.reportTimeline[0].blockers, []);

    // fleetModelFor: the turn-path lookup resolves the same chain per preset
    const plan = fleetModelFor(fleetDb, "persona-a", {
      roster: ["strong-m", "boot-m"],
      cellDefault: "boot-m",
    });
    assert.equal(plan.memberId, patrol.id);
    assert.equal(plan.effective, "strong-m");
    assert.ok(plan.notices.some((n) => /post model 'cheap-m'/.test(n)));
  } finally {
    server.close();
  }
});

// The turn-path normalization: same stub-bridge shape as the identity tests in
// report-lane, plus a recording switchModelTo and a plan-returning resolver.
function modelTurnCtx(planFor) {
  const ctx = {
    currentPreset: "persona-a",
    isStreaming: false,
    sessionCollectors: new Map(),
    sessionVersion: 1,
    broadcast: () => {},
    onRuntimeIdle: () => {},
    reserveRuntime: () => () => {},
    switchPresetTo: async () => ({ ok: true }),
    switchModelTo: async (id) => {
      ctx.modelSwitches.push(id);
      return ctx.modelSwitchResult === undefined ? { ok: true } : ctx.modelSwitchResult(id);
    },
    resolveFleetModel: planFor,
    recordFleetModelNotices: (id, n) => {
      if (n?.length) ctx.recordedNotices.push([id, n]);
    },
    recordedNotices: [],
    modelSwitches: [],
    prompts: [],
    dshBridge: {
      isReady: () => true,
      prompt: async (sessionId, blocks) => {
        ctx.prompts.push(blocks[0].text);
        ctx.sessionCollectors.get(sessionId)?.({ method: "session.status", params: { status: "idle" } });
      },
    },
  };
  attachCronRunner(ctx);
  return ctx;
}

test("member turn normalizes the model; fallback and honest failure", async () => {
  const job = { id: "job_m1", sessionId: "sess_m1", prompt: "巡视", preset: "persona-a", sessionTitle: "岗" };

  // 1) declared model lands: the runtime switch precedes the prompt
  const okCtx = modelTurnCtx(() => ({
    memberId: "m_1",
    candidates: [{ model: "cheap-m", source: "member" }],
    notices: [],
  }));
  const out = await okCtx.runCronJobTurn(job, { turnTimeoutMs: 2000 });
  assert.equal(out.ok, true);
  assert.deepEqual(okCtx.modelSwitches, ["cheap-m"]);
  assert.equal(okCtx.prompts.length, 1);

  // 2) declared hop dead at selection time: fall to the fleet default, record
  // the notice for the report bridge
  const fbCtx = modelTurnCtx(() => ({
    memberId: "m_1",
    candidates: [{ model: "strong-m", source: "fleet-default" }],
    notices: ["declared post model 'cheap-m' is not in the runner's model roster — falling through"],
  }));
  assert.equal((await fbCtx.runCronJobTurn({ ...job, sessionId: "sess_m2", id: "job_m2" }, { turnTimeoutMs: 2000 })).ok, true);
  assert.deepEqual(fbCtx.modelSwitches, ["strong-m"]);
  assert.equal(fbCtx.recordedNotices.length, 1);
  assert.equal(fbCtx.recordedNotices[0][0], "m_1");

  // 3) roster drifts again between resolution and switch: the loop walks to
  // the next candidate instead of dying on the first refusal
  const driftCtx = modelTurnCtx(() => ({
    memberId: "m_1",
    candidates: [{ model: "cheap-m", source: "member" }, { model: "boot-m", source: "cell-default" }],
    notices: [],
  }));
  driftCtx.modelSwitchResult = (id) => (id === "cheap-m" ? { ok: false, error: `Unknown model: ${id}` } : { ok: true });
  assert.equal((await driftCtx.runCronJobTurn({ ...job, sessionId: "sess_m3", id: "job_m3" }, { turnTimeoutMs: 2000 })).ok, true);
  assert.deepEqual(driftCtx.modelSwitches, ["cheap-m", "boot-m"]);

  // 4) no runnable model at all: the turn fails honestly, naming why
  const deadCtx = modelTurnCtx(() => ({ memberId: "m_1", candidates: [], notices: ["declared post model 'cheap-m' is not in the runner's model roster — falling through"] }));
  const dead = await deadCtx.runCronJobTurn({ ...job, sessionId: "sess_m4", id: "job_m4" }, { turnTimeoutMs: 2000 });
  assert.equal(dead.ok, false);
  assert.match(dead.error, /no runnable model/);
  assert.equal(deadCtx.prompts.length, 0, "nothing dispatched without a model");

  // 5) non-fleet persona turn: resolver yields null → the model is untouched
  // (byte-for-byte the pre-change behavior)
  const plainCtx = modelTurnCtx(() => null);
  assert.equal((await plainCtx.runCronJobTurn({ ...job, sessionId: "sess_m5", id: "job_m5" }, { turnTimeoutMs: 2000 })).ok, true);
  assert.deepEqual(plainCtx.modelSwitches, [], "non-fleet turns never touch the model");
});

test("post model/identity: archived-fleet ghost posts exit attribution (0030e1e8 family)", async () => {
  const { fleetIdentityFor } = await import("../server/fleet-reports.js");
  const live = fixtureFleet(fleetDb, { name: "活舰队" });
  const livePost = fixtureMember(fleetDb, live.id, { title: "真岗", targetId: "persona-a" });
  fleetDb.updateMember(livePost.id, { model: "cheap-m" }); // the fixture predates model fields
  const ghostFleet = fixtureFleet(fleetDb, { name: "已解散舰队" });
  const ghost = fixtureMember(fleetDb, ghostFleet.id, { title: "幽灵岗", targetId: "persona-a" });
  void ghost;
  fleetDb.updateFleet(ghostFleet.id, { state: "archived" });

  // model plan resolves to the LIVE post alone — the ghost must not push the
  // attribution into ambiguous-null (which would silently skip normalization)
  const plan = fleetModelFor(fleetDb, "persona-a", { roster: ["cheap-m"], cellDefault: "boot-m" });
  assert.equal(plan?.memberId, livePost.id, "ghost does not make the live post ambiguous");
  assert.equal(plan.effective, "cheap-m");

  // same seam, identity side
  const line = fleetIdentityFor(fleetDb, "persona-a");
  assert.match(line, /post=/);
  assert.ok(line.includes(livePost.id), "identity names the live post");
});

// ── Fleet row audit (add-fleet-row-update-audit) ────────────────────────────
// Two layers, adjudicated by pairing: the DB trigger is ground truth (every
// writer, including out-of-process SQL), updateFleet's meta stamps attribution
// on the row it caused. Trigger-with-attribution = in-platform; without =
// out-of-process.

test("audit: attributed updateFleet lands actor/via + orch old→new; out-of-process UPDATE lands a row without actor", () => {
  const fleet = fleetDb.createFleet({ id: "audit_f1", name: "Audited", ownerEmail: "owner@test.example" });
  fleetDb.updateFleet(fleet.id, { orchestration: { mode: "supervisor", edges: [] } },
    { actor: "owner@test.example", via: "PATCH /api/fleets/audit_f1" });

  let rows = fleetDb.db.prepare("SELECT * FROM fleet_row_audit WHERE fleet_id = ? ORDER BY id").all(fleet.id);
  assert.equal(rows.length, 1, "createFleet is an INSERT — the first UPDATE-triggered row is the orchestration write");
  const orchRow = rows[0];
  assert.equal(orchRow.actor, "owner@test.example");
  assert.equal(orchRow.via, "PATCH /api/fleets/audit_f1");
  assert.deepEqual(JSON.parse(orchRow.changed_columns), ["orchestration"]);
  assert.equal(orchRow.orchestration_old, null);
  assert.ok(orchRow.orchestration_new.includes("supervisor"));
  assert.ok(Number.isInteger(orchRow.ts));

  // Out-of-process write: raw SQL bypasses updateFleet entirely — the
  // trigger still lands the row, attribution stays NULL (the adjudication
  // marker for "this write did not come from the platform").
  fleetDb.db.exec(`UPDATE fleets SET name = 'Reset By Shell' WHERE id = '${fleet.id}'`);
  rows = fleetDb.db.prepare("SELECT * FROM fleet_row_audit WHERE fleet_id = ? ORDER BY id").all(fleet.id);
  const shellRow = rows[rows.length - 1];
  assert.deepEqual(JSON.parse(shellRow.changed_columns), ["name"]);
  assert.equal(shellRow.actor, null);
  assert.equal(shellRow.via, null);

  // Regular in-process update without meta: behavior unchanged, audit row
  // still lands (trigger), attribution absent but distinguishable from shell
  // only by correlation with logs — meta-less callers are legacy only.
  fleetDb.updateFleet(fleet.id, { state: "paused" });
  rows = fleetDb.db.prepare("SELECT * FROM fleet_row_audit WHERE fleet_id = ? ORDER BY id").all(fleet.id);
  assert.equal(rows.length, 3);
  assert.deepEqual(JSON.parse(rows[2].changed_columns), ["state"]);
});

test("audit: orchestration reset to null warns outside the owner's HTTP session, stays silent for it", () => {
  const fleet = fleetDb.createFleet({ id: "audit_f2", name: "Warned", ownerEmail: "owner2@test.example" });
  fleetDb.updateFleet(fleet.id, { orchestration: { mode: "supervisor", edges: [] } });

  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    // Owner via the fleet router: no warn.
    fleetDb.updateFleet(fleet.id, { orchestration: null },
      { actor: "owner2@test.example", via: "PATCH /api/fleets/audit_f2" });
    // Same human, non-HTTP path (e.g. an internal tool): warn.
    fleetDb.updateFleet(fleet.id, { orchestration: { mode: "supervisor", edges: [] } },
      { actor: "owner2@test.example", via: "fleet-architect:applyFleetDraft:edit" });
    fleetDb.updateFleet(fleet.id, { orchestration: null },
      { actor: "owner2@test.example", via: "fleet-architect:applyFleetDraft:edit" });
    // No meta at all: warn with the unknown marker.
    fleetDb.updateFleet(fleet.id, { orchestration: { mode: "supervisor", edges: [] } });
    fleetDb.updateFleet(fleet.id, { orchestration: null });
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warns.length, 2, "only the non-owner-HTTP resets warn");
  assert.match(warns[0], /orchestration reset to null.*fleet-architect/);
  assert.match(warns[1], /orchestration reset to null.*unknown/);
  // Every reset is still audited with old→new values.
  const resets = fleetDb.db
    .prepare("SELECT orchestration_old, orchestration_new, actor FROM fleet_row_audit WHERE fleet_id = ? AND orchestration_new IS NULL AND orchestration_old IS NOT NULL")
    .all(fleet.id);
  assert.equal(resets.length, 3);
});

// ── projection overview (add-fleet-cockpit-projection) ──────────────────────

test("overview: owner projection bounded + non-owner 403", async () => {
  const universe = { "persona-a": { name: "甲" }, "persona-b": { name: "乙" } };

  // Fleet A: one hourly post (missing — never materialized here), one passive
  // post with a report, two open decisions (high beats normal regardless of
  // expiry).
  const fleetA = fleetDb.createFleet({ id: "fa", name: "甲队", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "ma1", fleetId: fleetA.id, title: "电商部", parentId: null, targetKind: "persona", targetId: "persona-a", kpiSlots: [{ key: "sales", label: "销售额" }], cadence: HOURLY });
  fleetDb.createMember({ id: "ma2", fleetId: fleetA.id, title: "内容部", parentId: "ma1", targetKind: "persona", targetId: "persona-b", kpiSlots: [{ key: "videos", label: "本周视频" }], cadence: null });
  fleetDb.appendReport({
    id: "r1", fleetId: fleetA.id, memberId: "ma2", sessionId: "s",
    metrics: { videos: { value: 0, delta: "持平" }, extra: { value: "x" } },
    resources: [], blockers: [],
    summary: "x".repeat(200), source: "self", createdAt: Date.now() - 3600_000,
  });
  fleetDb.appendDecision({
    id: "d_normal", fleetId: fleetA.id, memberId: "ma2", question: "早到期普通", options: [],
    severity: "normal", submittedAt: Date.now() - 3600_000,
  });
  fleetDb.appendDecision({
    id: "d_high", fleetId: fleetA.id, memberId: "ma1", question: "y".repeat(200), options: [],
    severity: "high", submittedAt: Date.now() - 7200_000,
  });
  // Fleet B on the same owner rides along.
  fleetDb.createFleet({ id: "fb", name: "乙队", ownerEmail: "owner@test" });

  // auth-on, cell pinned to owner@test: header user drives identity.
  const { server, call } = await startServer(
    { authEnabled: true, cellUserEmail: "owner@test", fleetTargetResolver: makeResolver(universe) },
    { userHeader: true },
  );
  try {
    const anon = await call("GET", "/api/fleets/overview");
    assert.equal(anon.status, 401);
    const stranger = await call("GET", "/api/fleets/overview", undefined, { "x-test-user": "other@test" });
    assert.equal(stranger.status, 403);

    const r = await call("GET", "/api/fleets/overview", undefined, { "x-test-user": "owner@test" });
    assert.equal(r.status, 200);
    assert.equal(r.body.v, 1);
    assert.ok(Number.isFinite(r.body.sampledAt));
    assert.equal(r.body.fleets.length, 2);

    const a = r.body.fleets.find((f) => f.id === "fa");
    assert.ok(a.counts.missing >= 1, "hourly post with no task reads missing");
    assert.equal(a.counts.passive, 1);
    assert.equal(a.counts.total, 2);

    // Decisions: high first regardless of expiry; snips bounded; member title.
    assert.equal(a.openDecisions.count, 2);
    assert.equal(a.openDecisions.top.length, 2);
    assert.equal(a.openDecisions.top[0].severity, "high");
    assert.ok(a.openDecisions.top[0].question.length <= 81, "question snipped to ≤80+ellipsis");
    assert.equal(a.openDecisions.top[0].memberTitle, "电商部");
    assert.ok(a.openDecisions.top.every((d) => Number.isFinite(d.expiresAt)));

    // Stream: one line per member; summary snipped; declared slots only (≤4).
    const shop = a.stream.find((s) => s.title === "内容部");
    assert.equal(shop.status, "passive");
    assert.ok(shop.summarySnip.length <= 121);
    assert.deepEqual(Object.keys(shop.metrics), ["videos"]);
    assert.equal(shop.at > 0, true);
    assert.equal(shop.source, "self");
  } finally {
    server.close();
  }
});
