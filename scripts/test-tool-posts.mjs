// Unit tests for tool posts (add-tool-posts, agent-fleet-core T1).
//
// Covers the spec pins:
//   - splitToolTarget shape; runToolTurn three states (deterministic ok via
//     an injected stdio client, non-JSON arguments, unroutable server)
//   - the cron-runner branch: targetType=tool routes to the tool executor
//     and the O1 event meta carries model=null (no LLM)
//   - write face: tool target validation (shape/routable/JSON cadence/model
//     refused), multi-post exemption from the unique-post rule
//   - materializedSpec + specDrift: tool posts materialize as targetType=tool
//   - dispatch to a tool post: the brief must BE the JSON arguments; a tool
//     hop's handoff edge carries `args` (graph validation pins its shape)
//   - the estimator splits tool turns (tokens zero) from LLM turns
//
// Run: node --test scripts/test-tool-posts.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tool-posts-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const chatHistory = await import("../chat-history.js");
const cron = await import("../cron.js");
const { initDb } = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { splitToolTarget, runToolTurn } = await import("../server/tool-turn.js");
const { attachCronRunner } = await import("../server/cron-runner.js");
const { materializedSpec, specDrift } = await import("../server/fleet-reconcile.js");
const { validateOrchestration } = await import("../server/fleet-orchestration.js");
const { estimateFleetCost } = await import("../server/fleet-architect.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

await initDb();
await chatHistory.initChatHistory();
await engine.initTaskEngine({
  broadcast: () => {},
  runTurn: async () => ({ ok: true, text: "ok" }),
  isBusy: () => false,
});

test.after(async () => {
  cron.shutdown?.();
  await engine.idle?.();
  await new Promise((r) => setTimeout(r, 250));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let fleetDb;
beforeEach(() => {
  fleetDb = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
  setFleetDatabase(fleetDb);
});

// ── 1. executor ─────────────────────────────────────────────────────────────

test("splitToolTarget: shape only", () => {
  assert.deepEqual(splitToolTarget("websearch::search"), { server: "websearch", tool: "search" });
  assert.equal(splitToolTarget("no-separator"), null);
  assert.equal(splitToolTarget("a::"), null);
  assert.equal(splitToolTarget("::b"), null);
});

test("runToolTurn: deterministic ok / bad args / unroutable", async () => {
  const calls = [];
  const deps = {
    resolveStdio: (server) => (server === "localtools" ? { command: "node", args: [] } : null),
    resolveEndpoint: (server) => (server === "remotetools" ? "https://example.invalid/mcp" : null),
    stdioCall: async ({ toolName, args }) => {
      calls.push({ toolName, args });
      return { content: [{ type: "text", text: '{"n":42}' }] };
    },
    lineCall: async () => ({ content: [{ type: "text", text: "{}" }] }),
  };

  const ok = await runToolTurn({}, { id: "t1", preset: "localtools::fetch", prompt: '{"url":"https://x"}', sessionId: "s1" }, 5000, deps);
  assert.equal(ok.ok, true);
  assert.deepEqual(calls[0].args, { url: "https://x" });
  assert.equal(calls[0].toolName, "fetch");

  const badArgs = await runToolTurn({}, { id: "t2", preset: "localtools::fetch", prompt: "随便一句话" }, 5000, deps);
  assert.equal(badArgs.ok, false);
  assert.ok(badArgs.error.includes("JSON object"));

  const dead = await runToolTurn({}, { id: "t3", preset: "nowhere::fetch", prompt: "{}" }, 5000, deps);
  assert.equal(dead.ok, false);
  assert.ok(dead.error.includes("not routable"));

  const badShape = await runToolTurn({}, { id: "t4", preset: "localtools::fetch", prompt: "[1,2]" }, 5000, deps);
  assert.equal(badShape.ok, false);
});

test("cron-runner branch: tool turns route to the tool executor, event model=null", async () => {
  let toolOut = null;
  const recorded = [];
  const ctx = {
    session: { model: { id: "should-not-appear" } },
    taskTurnRegistry: new Map(),
    recordFleetTurnEvent: (job, out, meta) => recorded.push({ job, out, meta }),
    triggerFleetHandoffs: async () => null,
  };
  attachCronRunner(ctx, {
    runPersona: async () => ({ ok: true }),
    runA2a: async () => ({ ok: true }),
    runTool: async (_ctx, _job) => (toolOut = { ok: true, text: '{"n":1}' }),
    listAgents: () => [],
  });
  const r = await ctx.runCronJobTurn({ id: "j1", targetType: "tool", preset: "localtools::fetch", prompt: "{}", sourceTag: { fleetId: "f", memberId: "m" } });
  assert.deepEqual(r, { ok: true, text: '{"n":1}' });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].meta.model, null, "no LLM — model metadata is meaningless and records null");
});

// ── 2. write face ───────────────────────────────────────────────────────────

async function startServer(ctx) {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const resolver = (m) => ({
  alive: m.targetKind === "tool" ? !!splitToolTarget(m.targetId) : !!m.targetId,
  label: m.targetId,
  clusterName: null,
});

test("write face: tool validation, model refusal, multi-post exemption", async () => {
  const fleet = fleetDb.createFleet({ id: "f_t", name: "工具舰", ownerEmail: "owner@test" });
  const { server, base } = await startServer({ authEnabled: false, cellUserEmail: "owner@test", fleetTargetResolver: resolver });
  const post = (body) =>
    fetch(`${base}/api/fleets/${fleet.id}/members`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  try {
    const ok = await post({ title: "抓取", targetKind: "tool", targetId: "localtools::fetch", cadence: { cron: "0 * * * *", tz: null, promptTemplate: '{"url":"https://x"}' } });
    assert.equal(ok.status, 201);

    // same tool again: exempt from unique-post
    const again = await post({ title: "抓取二", targetKind: "tool", targetId: "localtools::fetch", cadence: null });
    assert.equal(again.status, 201);

    const badJson = await post({ title: "坏参数", targetKind: "tool", targetId: "localtools::fetch", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "不是JSON" } });
    assert.equal(badJson.status, 400);
    assert.ok(badJson.body.error.includes("JSON object"));

    const badShape = await post({ title: "坏形状", targetKind: "tool", targetId: "localtools::fetch", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "[1]" } });
    assert.equal(badShape.status, 400);

    const withModel = await post({ title: "带模型", targetKind: "tool", targetId: "localtools::fetch", cadence: null, model: "glm-4.7" });
    assert.equal(withModel.status, 400);
    assert.ok(withModel.body.error.includes("run no LLM"));

    const badTarget = await post({ title: "坏目标", targetKind: "tool", targetId: "no-double-colon", cadence: null });
    assert.equal(badTarget.status, 400);
    assert.ok(badTarget.body.error.includes("server::tool"));
  } finally {
    server.close();
  }
});

test("dispatch to a tool post: brief must be the JSON arguments", async () => {
  const fleet = fleetDb.createFleet({ id: "f_d", name: "派发舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "m_sup", fleetId: fleet.id, title: "主管", targetKind: "persona", targetId: "p-sup", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "m_tool", fleetId: fleet.id, title: "抓取", targetKind: "tool", targetId: "localtools::fetch", kpiSlots: [], cadence: null });
  fleetDb.updateFleet(fleet.id, { orchestration: { mode: "supervisor" } });

  const { server, base } = await startServer({ authEnabled: false, cellUserEmail: "owner@test", currentPreset: "p-sup", fleetTargetResolver: resolver });
  const call = (body) =>
    fetch(`${base}/api/fleets/dispatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  try {
    const bad = await call({ to: "m_tool", brief: "去抓一下首页" });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error.includes("JSON arguments"));

    const ok = await call({ to: "m_tool", brief: '{"url":"https://example.com"}' });
    assert.equal(ok.status, 201);
    const task = engine.getTaskRecord(ok.body.taskId);
    assert.equal(task.targetType, "tool");
    assert.equal(task.preset, "localtools::fetch");
    assert.equal(task.prompt, '{"url":"https://example.com"}');
  } finally {
    server.close();
  }
});

// ── 3. materialization & graph & estimate ───────────────────────────────────

test("materializedSpec/specDrift: tool posts materialize as targetType=tool", () => {
  const fleet = { id: "f", name: "舰" };
  const member = { id: "m", title: "抓取", targetKind: "tool", targetId: "localtools::fetch", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "{}" } };
  const spec = materializedSpec({ fleet, member });
  assert.equal(spec.tool, "localtools::fetch");
  const drift = specDrift({ targetType: "persona", preset: "old" }, spec);
  assert.equal(drift.tool, "localtools::fetch");
});

test("orchestration: a tool hop's edge args must be a JSON object", () => {
  const members = [{ id: "a", title: "a" }, { id: "t", title: "t" }];
  const okEdge = validateOrchestration({ members, orchestration: { edges: [{ kind: "handoff", from: "a", to: "t", args: { url: "https://x" } }] } });
  assert.equal(okEdge.ok, true);
  const badEdge = validateOrchestration({ members, orchestration: { edges: [{ kind: "handoff", from: "a", to: "t", args: "not-an-object" }] } });
  assert.equal(badEdge.ok, false);
  assert.ok(badEdge.errors.some((e) => e.error.includes("args must be a JSON object")));
});

test("estimate: tool turns count, tokens zero", () => {
  const est = estimateFleetCost({
    mode: "create",
    members: [
      { op: "add", title: "抓取", targetKind: "tool", targetId: "s::t", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "{}" } },
      { op: "add", title: "撰稿", targetKind: "persona", targetId: "p", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "写" } },
    ],
  }, { newPostCount: 2 });
  assert.equal(est.turnsPerDayTotal, 48);
  assert.equal(est.toolTurnsPerDay, 24);
  assert.equal(est.llmTurnsPerDay, 24);
  assert.deepEqual(est.tokensPerMonth, [24 * 30 * 3000, 24 * 30 * 8000]);
  assert.ok(est.posts.some((p) => p.toolPost));
});
