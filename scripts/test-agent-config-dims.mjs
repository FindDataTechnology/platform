// Unit tests for the two config dimensions beyond the model
// (add-agent-config-dims): effort resolution + context-budget verdict.
//
//   - resolveAgentEffort: declaration order (post → fleet → cell), a level the
//     effective model does not declare falls through with a notice, no
//     declarations → null/silent, unknown model → cannot judge (pass through,
//     never block a turn over a roster hiccup)
//   - effortDeclarations registry: setEffortDeclarations seeds it; an unknown
//     model reads null
//   - context budget: over budget fails as context_budget with both numbers in
//     the summary; no budget → no verdict; no usage → never judged (honest
//     absence, never an invented zero)
//
// Run: node --test scripts/test-agent-config-dims.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { resolveAgentEffort, setEffortDeclarations, effortDeclarationsFor } = await import("../server/fleet-model.js");
const { shapeTurnOutcome, ERROR_KINDS } = await import("../server/fleet-events.js");

test("effort: post declaration wins when the model declares the level", () => {
  setEffortDeclarations({ "m-reasoner": ["low", "medium", "high"] });
  const r = resolveAgentEffort({ agentEffort: "high", fleetEffort: "low", model: "m-reasoner" });
  assert.equal(r.effort, "high");
  assert.equal(r.source, "post");
  assert.deepEqual(r.notices, []);
});

test("effort: fleet default applies when the post declares nothing", () => {
  setEffortDeclarations({ "m-reasoner": ["low", "medium"] });
  const r = resolveAgentEffort({ agentEffort: null, fleetEffort: "medium", model: "m-reasoner" });
  assert.equal(r.effort, "medium");
  assert.equal(r.source, "fleet");
});

test("effort: an unsupported level falls through with a notice, never throws", () => {
  setEffortDeclarations({ "m-reasoner": ["low", "medium"] });
  const r = resolveAgentEffort({ agentEffort: "high", fleetEffort: "low", model: "m-reasoner" });
  assert.equal(r.effort, "low", "falls to the next declaration that IS supported");
  assert.equal(r.source, "fleet");
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0], /post thinking level 'high' is not supported/);
});

test("effort: nothing declared → null and silent (inherit the global level)", () => {
  setEffortDeclarations({ "m-reasoner": ["high"] });
  const r = resolveAgentEffort({ model: "m-reasoner" });
  assert.equal(r.effort, null);
  assert.equal(r.source, null);
  assert.deepEqual(r.notices, [], "inheritance is normal — no notice");
});

test("effort: unknown model cannot be judged → pass the declaration through", () => {
  setEffortDeclarations({ "m-reasoner": ["high"] });
  const r = resolveAgentEffort({ agentEffort: "high", model: "m-unknown" });
  assert.equal(r.effort, "high", "a roster hiccup must not block the turn");
  assert.deepEqual(r.notices, []);
  assert.equal(effortDeclarationsFor("m-unknown"), null);
});

test("effort: all declarations unsupported → null with one notice each", () => {
  setEffortDeclarations({ "m-reasoner": ["low"] });
  const r = resolveAgentEffort({ agentEffort: "high", fleetEffort: "medium", model: "m-reasoner" });
  assert.equal(r.effort, null);
  assert.equal(r.notices.length, 2);
});

test("context budget: over budget fails as context_budget with both numbers", () => {
  assert.ok(ERROR_KINDS.includes("context_budget"), "the enum carries the new kind");
  const shaped = shapeTurnOutcome({ ok: true, usage: { input: 7000, output: 2000 } }, { contextBudget: 8000 });
  assert.equal(shaped.status, "failed");
  assert.equal(shaped.errorKind, "context_budget");
  assert.match(shaped.error, /9000/);
  assert.match(shaped.error, /8000/);
});

test("context budget: within budget keeps the turn ok", () => {
  // Fixture carries text on purpose (fix-stub-turn-success): `{usage:{output:50}}`
  // with no text/tool/report is the STUB shape now — that assertion belongs to
  // test-stub-turn, not here. This test is about budget arithmetic only.
  const shaped = shapeTurnOutcome({ ok: true, usage: { input: 100, output: 50 }, text: "结论" }, { contextBudget: 8000 });
  assert.equal(shaped.status, "ok");
  assert.equal(shaped.errorKind, null);
});

test("context budget: undeclared means no verdict", () => {
  const shaped = shapeTurnOutcome({ ok: true, usage: { input: 999999, output: 1 }, text: "结论" }, {});
  assert.equal(shaped.status, "ok");
});

test("context budget: no reported usage is never judged", () => {
  const shaped = shapeTurnOutcome({ ok: true }, { contextBudget: 100 });
  assert.equal(shaped.status, "ok", "no basis → no verdict, never an invented zero");
});

// ── write-face gate (add-agent-config-dims 1.5): one rule, three doors ──────

test("write gate: fleet member PATCH rejects an illegal effort and an out-of-range budget, then accepts and clears", async () => {
  const { createFleetRoutes } = await import("../server/routes/fleets.js");
  const express = (await import("express")).default;
  const { setEffortDeclarations } = await import("../server/fleet-model.js");
  setEffortDeclarations({ "m-x": ["low", "medium", "high"] });
  const path = await import("node:path");
  const os = await import("node:os");
  const fs = await import("node:fs");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dims-write-"));
  const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
  const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
  setFleetDatabase(fleetDb);
  const fleet = fleetDb.createFleet({ id: "f_dims", name: "dims", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "m1", fleetId: fleet.id, title: "岗", targetKind: "persona", targetId: "p1", kpiSlots: [], cadence: null });

  const app = express();
  app.use(express.json());
  createFleetRoutes(app, { authEnabled: false, cellUserEmail: "owner@test", fleetTargetResolver: (m) => ({ alive: true, label: m.targetId }), dshModels: [{ id: "m-x", reasoningEfforts: ["low", "medium", "high"] }] });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const patch = (body) => fetch(`${base}/api/fleets/f_dims/members/m1`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  try {
    // illegal effort
    const bad = await patch({ effort: "ultra" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /choose one of: low, medium, high/);
    // out-of-range budget
    const badB = await patch({ contextBudget: 10 });
    assert.equal(badB.status, 400);
    // legal lands
    const ok = await patch({ effort: "high", contextBudget: 16000 });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.member.effort, "high");
    assert.equal(body.member.contextBudget, 16000);
    // clear
    const clr = await patch({ effort: null, contextBudget: null });
    assert.equal((await clr.json()).member.effort, null);
    // fleet PATCH carries the same gate
    const badF = await fetch(`${base}/api/fleets/f_dims`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ effort: "ultra" }) });
    assert.equal(badF.status, 400);
    const okF = await fetch(`${base}/api/fleets/f_dims`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ effort: "low", contextBudget: 32000 }) });
    assert.equal((await okF.json()).fleet.effort, "low");
  } finally {
    server.close();
    fleetDb.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("write gate: bots PATCH validates effort/budget through the same union", async () => {
  const { registerBotRoutes } = await import("../server/routes/bots.js");
  const express = (await import("express")).default;
  const { setEffortDeclarations } = await import("../server/fleet-model.js");
  setEffortDeclarations({ "m-x": ["low", "high"] });
  const path = await import("node:path");
  const os = await import("node:os");
  const fs = await import("node:fs");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dims-bot-"));
  process.env.DB_PATH = path.join(tmpRoot, "app.db");
  process.env.PLATFORM_DATA_DIR = tmpRoot;
  const { initDb } = await import("../db.js");
  await initDb();
  const dbMod = await import("../db.js");
  const bot = dbMod.addBot({ id: "b_dims", type: "generic", name: "B", credentials: {}, secret: "s" });

  const app = express();
  app.use(express.json());
  registerBotRoutes({ app, db: dbMod, requireAdmin: () => true, dshModels: [{ id: "m-x", reasoningEfforts: ["low", "high"] }] });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const patch = (body) => fetch(`${base}/api/bots/b_dims`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  try {
    const bad = await patch({ effort: "medium" });
    assert.equal(bad.status, 400);
    const ok = await patch({ effort: "high", contextBudget: 4096 });
    assert.equal(ok.status, 200);
    const saved = dbMod.getBot("b_dims");
    assert.equal(saved.effort, "high");
    assert.equal(saved.contextBudget, 4096);
  } finally {
    server.close();
    dbMod.deleteBot(bot.id);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── create-face parity (fix-member-config-complete D1) ─────────────────────
//
// POST /members used to read only title/target/cadence/model, so a create that
// carried effort/contextBudget/carrier/packId returned 201 with the values
// silently dropped. These pin "same door, same gate, same landing" against the
// PATCH path so the two cannot drift apart again.

test("write gate: POST /members lands effort/contextBudget/carrier/packId, identical to PATCH", async () => {
  const { createFleetRoutes } = await import("../server/routes/fleets.js");
  const express = (await import("express")).default;
  const { setEffortDeclarations } = await import("../server/fleet-model.js");
  setEffortDeclarations({ "m-x": ["low", "medium", "high"] });
  const path = await import("node:path");
  const os = await import("node:os");
  const fs = await import("node:fs");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dims-create-"));
  const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
  const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
  setFleetDatabase(fleetDb);
  const fleet = fleetDb.createFleet({ id: "f_mk", name: "mk", ownerEmail: "owner@test" });

  const app = express();
  app.use(express.json());
  createFleetRoutes(app, {
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: (m) => ({ alive: true, label: m.targetId }),
    dshModels: [{ id: "m-x", reasoningEfforts: ["low", "medium", "high"] }],
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const create = (body) => fetch(`${base}/api/fleets/f_mk/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "岗", targetKind: "persona", targetId: "p1", ...body }),
  });

  try {
    // (1) all four dimensions land on create and read back verbatim
    const ok = await create({ effort: "high", contextBudget: 16000, carrier: "cell", packId: "pack-a" });
    assert.equal(ok.status, 201);
    const made = (await ok.json()).member;
    assert.equal(made.effort, "high");
    assert.equal(made.contextBudget, 16000);
    assert.equal(made.carrier, "cell");
    assert.equal(made.packId, "pack-a");

    // (2) equivalence with "create first, then PATCH the same values"
    const plain = await create({ targetId: "p2" });
    assert.equal(plain.status, 201);
    const plainId = (await plain.json()).member.id;
    const patched = await fetch(`${base}/api/fleets/f_mk/members/${plainId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ effort: "high", contextBudget: 16000, carrier: "cell", packId: "pack-a" }),
    });
    assert.equal(patched.status, 200);
    const viaPatch = (await patched.json()).member;
    for (const k of ["effort", "contextBudget", "carrier", "packId"]) {
      assert.equal(made[k], viaPatch[k], `${k}: create and create-then-PATCH must agree`);
    }

    // (3) illegal values are refused BEFORE the row exists
    const before = fleetDb.listMembers(fleet.id).length;
    const badEffort = await create({ targetId: "p3", effort: "ultra" });
    assert.equal(badEffort.status, 400);
    assert.match((await badEffort.json()).error, /choose one of: low, medium, high/);
    const badCarrier = await create({ targetId: "p3", carrier: "broom" });
    assert.equal(badCarrier.status, 400);
    const badPack = await create({ targetId: "p3", packId: "x".repeat(65) });
    assert.equal(badPack.status, 400);
    const badBudget = await create({ targetId: "p3", contextBudget: 10 });
    assert.equal(badBudget.status, 400);
    assert.equal(fleetDb.listMembers(fleet.id).length, before, "rejected creates leave no rows");
  } finally {
    server.close();
    fleetDb.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── cleared declaration reaches the runtime (fix-member-config-complete D2) ──

test("effort landing: a cleared declaration drives the runtime back to the provider default", async () => {
  const { applyPostEffort } = await import("../server/cron-runner.js");

  // The bug: `if (plan.effort && …)` made the clear case indistinguishable from
  // "nothing to do", so the previous post's level stayed live.
  const calls = [];
  const ctx = { currentEffort: "high", switchEffortTo: async (v) => { calls.push(v); return { ok: true }; } };
  const notices = await applyPostEffort(ctx, { effort: null, memberId: "m1" });
  assert.deepEqual(calls, [null], "clearing must call switchEffortTo(null)");
  assert.deepEqual(notices, []);

  // Already at the provider default → zero calls (no per-turn churn).
  const idle = [];
  await applyPostEffort({ currentEffort: null, switchEffortTo: async (v) => { idle.push(v); return { ok: true }; } }, { effort: null });
  assert.deepEqual(idle, [], "same level ⇒ no switch");

  // A real declaration still switches.
  const up = [];
  await applyPostEffort({ currentEffort: null, switchEffortTo: async (v) => { up.push(v); return { ok: true }; } }, { effort: "low" });
  assert.deepEqual(up, ["low"]);

  // Degrade open: a failed switch is a notice, never a thrown turn.
  const failed = await applyPostEffort(
    { currentEffort: "high", switchEffortTo: async () => ({ ok: false, error: "no active model" }) },
    { effort: null },
  );
  assert.equal(failed.length, 1);
  assert.match(failed[0], /provider default/);
  assert.match(failed[0], /no active model/);
});

test.after(async () => {
  // db.js starts schedulers/flush timers at import; without this the runner
  // never exits (same cleanup the other fleet suites carry).
  try { const cron = await import("../cron.js"); cron.shutdown?.(); } catch {}
  try { const engine = await import("../task-engine.js"); await engine.idle?.(); } catch {}
  await new Promise((r) => setTimeout(r, 100));
});
