// Unit tests for fleet orchestration wave 1 (agent-fleet-orchestration).
//
// Covers the spec pins:
//   - validateOrchestration: legal trigger/report/dispatch/handoff edges,
//     unknown refs rejected, self-edges rejected, handoff cycle rejected,
//     chain over maxChainDepth rejected, span advisory (warning not error),
//     mode validation; null section = ok with zero edges
//   - mode expansion: supervisor adds implicit all→all dispatch edges
//     (marked), schedule/pipeline add nothing; dispatchAllowed follows
//     explicit edges or supervisor mode, refuses undeclared pairs and self
//   - the dispatch bridge: same-fleet/target-exists/no-self/edge-permission/
//     cluster-refusal/rate caps; a passing dispatch creates the manual task
//     with origin.fleet depth 1 + initiator (delegation lane)
//   - handoff at the seam: upstream ok and failed both relay honestly and
//     create the downstream task with chain depth + 1 and budget; over-bound
//     hops create no task but leave an honest event row
//   - write face: PATCH accepts a valid section (then cockpit reads it back
//     with expanded edges), rejects a cycling one; member delete drops
//     dangling edges; unset section = byte-identical schedule behavior
//
// Run: node --test scripts/test-fleet-orchestration.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-orch-"));
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
const {
  validateOrchestration,
  expandedEdges,
  dispatchAllowed,
  outgoingHandoffs,
  constraintsOf,
} = await import("../server/fleet-orchestration.js");
const { attachCronRunner } = await import("../server/cron-runner.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");
const { createFleetTurnLedger } = await import("../server/fleet-runs.js");
const { validateFleetDraft } = await import("../server/fleet-architect.js");

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
  // The engine's jobs.json writer is debounced — give the last flush (the
  // handoff/dispatch tasks this suite creates) time to land before the tmp
  // root goes away, or the rename surfaces as a post-test unhandled error.
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

function fixtureFleet(db, over = {}) {
  const f = db.createFleet({ id: over.id ?? `f_${Math.random().toString(36).slice(2, 8)}`, name: over.name ?? "流水线舰", ownerEmail: "owner@test", ...(over.orchestration ? { orchestration: over.orchestration } : {}) });
  for (const m of over.members ?? []) {
    db.createMember({ fleetId: f.id, kpiSlots: [], cadence: null, ...m });
  }
  return f;
}

const P = (id) => ({ id, title: id, parentId: null, targetKind: "persona", targetId: `t-${id}` });

// ── 1. graph validation ─────────────────────────────────────────────────────

test("validateOrchestration: legal edges pass; null = ok/empty", () => {
  // fix-report-edge: `b` really does report to `a` (parentId), so the declared
  // report edge states the truth — a declaration that contradicts the tree is
  // now refused (see scripts/test-report-edge-derived.mjs).
  const members = [P("a"), { ...P("b"), parentId: "a" }, P("c")];
  const ok = validateOrchestration({
    members,
    orchestration: {
      edges: [
        { kind: "trigger", to: "a", cron: "0 9 * * *" },
        { kind: "report", from: "b", to: "a" },
        { kind: "dispatch", from: "a", to: "b" },
        { kind: "handoff", from: "b", to: "c" },
      ],
    },
  });
  assert.equal(ok.ok, true);
  // 4 declared + the derived report edge for `c`… there is none (c has no
  // parent), and b→a is already declared, so the count stays 4.
  assert.equal(ok.edges.length, 4);

  const none = validateOrchestration({ members, orchestration: null });
  assert.equal(none.ok, true);
  assert.deepEqual(none.edges, []);
});

test("validateOrchestration: unknown refs, self-edges, bad kind/mode rejected", () => {
  const members = [P("a"), P("b")];
  for (const orch of [
    { edges: [{ kind: "handoff", from: "a", to: "ghost" }] },
    { edges: [{ kind: "dispatch", from: "a", to: "a" }] },
    { edges: [{ kind: "handoff", from: "a", to: "a" }] },
    { edges: [{ kind: "mystery", from: "a", to: "b" }] },
    { mode: "chaos" },
    { edges: "not-an-array" },
    { constraints: { maxChainDepth: -1 } },
  ]) {
    const out = validateOrchestration({ members, orchestration: orch });
    assert.equal(out.ok, false, JSON.stringify(orch));
  }
});

test("validateOrchestration: handoff cycle rejected; chain over bound rejected; span warns", () => {
  const members = [P("a"), P("b"), P("c")];
  const cyc = validateOrchestration({ members, orchestration: { edges: [
    { kind: "handoff", from: "a", to: "b" }, { kind: "handoff", from: "b", to: "a" },
  ] } });
  assert.equal(cyc.ok, false);
  assert.ok(cyc.errors.some((e) => e.error.includes("cycle")));

  const deep = validateOrchestration({ members, orchestration: {
    constraints: { maxChainDepth: 1 },
    edges: [{ kind: "handoff", from: "a", to: "b" }, { kind: "handoff", from: "b", to: "c" }],
  } });
  assert.equal(deep.ok, false);
  assert.ok(deep.errors.some((e) => e.error.includes("maxChainDepth")));

  const wide = validateOrchestration({ members, orchestration: {
    edges: Array.from({ length: 9 }, (_, i) => ({ kind: "dispatch", from: "a", to: i < 2 ? ["a", "b"][i] === "a" ? "b" : "b" : "b" })),
  } });
  void wide; // span advisory covered below with distinct targets
  const span = validateOrchestration({ members: [P("a"), ...Array.from({ length: 9 }, (_, i) => P(`t${i}`))], orchestration: {
    edges: Array.from({ length: 9 }, (_, i) => ({ kind: "dispatch", from: "a", to: `t${i}` })),
  } });
  assert.equal(span.ok, true, "span is advisory");
  assert.ok(span.warnings.some((w) => w.includes("span-8")));
});

test("mode expansion + dispatchAllowed", () => {
  const members = [P("a"), P("b"), P("c")];
  const sup = expandedEdges({ members, orchestration: { mode: "supervisor" } });
  assert.equal(sup.filter((e) => e.kind === "dispatch" && e.implicit).length, 6, "n×(n-1) implicit pairs");
  const sched = expandedEdges({ members, orchestration: { mode: "schedule", edges: [{ kind: "dispatch", from: "a", to: "b" }] } });
  assert.equal(sched.length, 1, "schedule adds nothing implicit");

  assert.equal(dispatchAllowed({ members, orchestration: { mode: "supervisor" } }, "a", "b").ok, true);
  assert.equal(dispatchAllowed({ members, orchestration: { mode: "supervisor" } }, "a", "a").ok, false);
  assert.equal(dispatchAllowed({ members, orchestration: { edges: [{ kind: "dispatch", from: "a", to: "b" }] } }, "a", "b").ok, true);
  assert.equal(dispatchAllowed({ members, orchestration: {} }, "a", "b").ok, false, "no edges, no mode ⇒ refused");
});

// fix-fleet-chain-operability D1: a declared handoff edge grants dispatch_post
// between exactly its two endpoints, both directions (forward = hand off,
// backward = return blocked work). Live 2026-10-31: the ontology fleet's
// five-post pipeline could not hand off at all — dispatch_post rejected every
// pair despite the four declared handoff edges, because dispatchAllowed only
// honored kind:"dispatch" and supervisor mode.
test("handoff edge grants paired dispatch (both directions)", () => {
  const members = [P("a"), P("b"), P("c")];
  const orch = { mode: "schedule", edges: [{ kind: "handoff", from: "a", to: "b" }] };

  assert.equal(dispatchAllowed({ members, orchestration: orch }, "a", "b").ok, true, "forward = hand off");
  assert.equal(dispatchAllowed({ members, orchestration: orch }, "b", "a").ok, true, "backward = return blocked work");
  assert.equal(dispatchAllowed({ members, orchestration: orch }, "a", "c").ok, false, "undeclared third post still refused");
  assert.equal(dispatchAllowed({ members, orchestration: orch }, "b", "c").ok, false, "no transitive grant along the chain");
  assert.equal(dispatchAllowed({ members, orchestration: { edges: [{ kind: "handoff", from: "a", to: "b" }] } }, "a", "a").ok, false, "self still refused");
  assert.equal(dispatchAllowed({ members, orchestration: {} }, "a", "b").ok, false, "no edges ⇒ refused");
  // Explicit dispatch edge on a DIFFERENT pair still works and grants nothing
  // extra; trigger/report edges grant nothing.
  assert.equal(
    dispatchAllowed({ members, orchestration: { edges: [{ kind: "trigger", from: "cron(0 9 * * *)", to: "a" }, { kind: "report", from: "b", to: "a" }] } }, "a", "b").ok,
    false,
    "trigger/report edges are not dispatch grants",
  );
  // The grant is read-time only: expandedEdges must not grow implicit rows.
  const expanded = expandedEdges({ members, orchestration: orch });
  assert.equal(expanded.length, 1, "handoff grant never materializes as an extra edge");
});

// ── 2. bridge: dispatch guards + task shape ─────────────────────────────────

async function startServer(ctx) {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("dispatch bridge: guards and the delegation-lane task shape", async () => {
  const other = fixtureFleet(fleetDb, { name: "别舰" });
  const _fleet = fixtureFleet(fleetDb, {
    id: "f_main",
    members: [P("m_sup"), P("m_exec"), P("m_cluster"), { id: "m_ghost", title: "幽灵", parentId: null, targetKind: "persona", targetId: "t-ghost", kpiSlots: [], cadence: null }],
    orchestration: { mode: "supervisor" },
  });
  fleetDb.createMember({ id: "m_other_post", fleetId: other.id, title: "外舰岗", targetKind: "persona", targetId: "t-m_cluster", kpiSlots: [], cadence: null });
  fleetDb.updateMember("m_cluster", { targetKind: "cluster", targetId: "cluster-x" });
  fleetDb.deleteMember("m_ghost");
  // A tool post: its prompt IS the JSON arguments (add-fleet-edge-context D1
  // pins that no context token is ever appended to it).
  fleetDb.createMember({ id: "m_tool", fleetId: "f_main", title: "工具岗", targetKind: "tool", targetId: "srv::do_thing", kpiSlots: [], cadence: null });
  chatHistory.setSessionManager({ getSessionId: () => "sess-sup" });

  const { server, base } = await startServer({
    authEnabled: false,
    cellUserEmail: "owner@test",
    currentPreset: "t-m_sup",
    fleetTargetResolver: (m) => ({ alive: true, label: m.targetId, clusterName: m.targetKind === "cluster" ? "cx" : null }),
  });
  const call = (body) =>
    fetch(`${base}/api/fleets/dispatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    // happy path: supervisor mode grants the pair, task rides the delegation lane
    const ok = await call({ to: "m_exec", brief: "写一篇周报" });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.to.memberId, "m_exec");
    const task = engine.getTaskRecord(ok.body.taskId);
    assert.equal(task.origin.fleet.depth, 1);
    assert.equal(task.origin.fleet.memberId, "m_exec");
    assert.equal(task.initiator, "sess-sup");
    // No ledger on this ctx → no chain stamped; the target will open a root
    // run of its own (agent-fleet-runs: honest degradation, never a guess).
    assert.equal(task.origin.fleet.chain, undefined);
    // 派发提示的词头是「集群派发」（产品词汇终词：舰队→集群；本断言曾写
    // 「舰队派发」，改名后一直红着）。三目表达式两支同值是死代码，一并清掉。
    assert.ok(task.prompt.includes("集群派发"), "dispatcher identity rides the prompt");
    assert.ok(task.prompt.includes("sup"), "the dispatcher's post identity names the brief");
    // add-fleet-edge-context D1: the dispatched persona post asks for the fleet
    // view; a tool post's prompt is its JSON arguments and must stay untouched.
    assert.ok(task.prompt.endsWith("{{fleetEdgeContext}}"), "persona dispatch carries the edge-context token");

    // guards: cross-fleet ref (foreign post id), self, cluster post, permission-less
    assert.equal((await call({ to: "m_other_post", brief: "x" })).status, 400);
    assert.equal((await call({ to: "m_sup", brief: "x" })).status, 400);
    assert.equal((await call({ to: "m_cluster", brief: "x" })).status, 400);
    assert.equal((await call({ to: "m_exec", brief: "" })).status, 400);

    // tool post: the brief is the arguments, byte-for-byte — no token, no text
    const toolRes = await call({ to: "m_tool", brief: '{"query":"x"}' });
    assert.equal(toolRes.status, 201);
    assert.equal(engine.getTaskRecord(toolRes.body.taskId).prompt, '{"query":"x"}', "tool prompt is its JSON arguments, untouched");

    // rate cap: per-post window — two more dispatches pass, the fourth 429s
    fleetDb.updateFleet("f_main", { orchestration: { mode: "supervisor" } });
    await call({ to: "m_exec", brief: "二" });
    await call({ to: "m_exec", brief: "三" });
    const capped = await call({ to: "m_exec", brief: "四" });
    assert.equal(capped.status, 429);
    assert.ok(capped.body.error.includes("cap"));
  } finally {
    server.close();
  }
});

test("dispatch bridge: no edge and no mode ⇒ 403", async () => {
  const fleet = fixtureFleet(fleetDb, { members: [P("m_a"), P("m_b")] });
  void fleet;
  const { server, base } = await startServer({
    authEnabled: false, cellUserEmail: "owner@test", currentPreset: "t-m_a",
    fleetTargetResolver: (m) => ({ alive: true, label: m.targetId }),
  });
  try {
    const r = await fetch(`${base}/api/fleets/dispatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "m_b", brief: "x" }) });
    assert.equal(r.status, 403);
    assert.ok((await r.json()).error.includes("declare the edge"));
  } finally {
    server.close();
  }
});

test("dispatch bridge: an in-flight upstream turn stamps chain on the task (agent-fleet-runs)", async () => {
  fixtureFleet(fleetDb, {
    id: "f_chain_disp",
    members: [P("m_sup"), P("m_exec")],
    orchestration: { mode: "supervisor" },
  });
  chatHistory.setSessionManager({ getSessionId: () => "sess-sup" });
  const ledger = createFleetTurnLedger({ db: fleetDb, engineRecords: () => engine.allRecords() });
  // The dispatcher's turn is mid-flight (cron lane) when dispatch_post lands.
  const upstreamJob = { id: "j_sup", trigger: "schedule", targetType: "persona", preset: "t-m_sup", sessionId: "cron-j_sup", sourceTag: { fleetId: "f_chain_disp", memberId: "m_sup" } };
  const handle = ledger.begin(upstreamJob, { startedAt: Date.now(), sessionIds: ["cron-j_sup#r1"] });
  const { server, base } = await startServer({
    authEnabled: false,
    cellUserEmail: "owner@test",
    currentPreset: "t-m_sup",
    fleetTargetResolver: (m) => ({ alive: true, label: m.targetId }),
    fleetTurnLedger: ledger,
  });
  try {
    const r = await fetch(`${base}/api/fleets/dispatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "m_exec", brief: "干活" }) });
    assert.equal(r.status, 201);
    const task = engine.getTaskRecord((await r.json()).taskId);
    assert.deepEqual(task.origin.fleet.chain, { runId: handle.runId, parentTurnId: handle.turnId, edgeKind: "dispatch" });
    // fix-dispatch-delivery D1: the receipt belongs to the DISPATCHING post's
    // turn session, not to the runtime's global session pointer (which only
    // names the live turn by luck and would hand the receipt to a web chat).
    assert.equal(task.initiator, handle.sessionId, "initiator = the in-flight turn's mirror session");
    assert.equal(task.initiatorPreset, "t-m-sup", "the dispatch receipt speaks as the dispatching post (its roster preset)");
    assert.ok(task.initiatorGroup?.startsWith("dispatch:"), "one dispatch = one aggregation group");
    ledger.end(upstreamJob, handle, { ok: true }, { startedAt: handle.startedAt, endedAt: Date.now() });
  } finally {
    server.close();
  }
});

// ── 3. handoff at the seam ──────────────────────────────────────────────────

test("handoff: ok and failed upstreams both relay; depth/budget ride origin; bound leaves an event", async () => {
  const fleet = fixtureFleet(fleetDb, {
    id: "f_chain",
    members: [P("m_up"), P("m_down")],
    orchestration: { edges: [{ kind: "handoff", from: "m_up", to: "m_down" }], constraints: { maxChainDepth: 2, budgetPerEdgeMin: 15 } },
  });
  void fleet;
  const created = [];
  const ctx = {
    session: { model: { id: "m0" } },
    taskTurnRegistry: new Map(),
    // 运行时就绪门替身：舰队任务在 dshBridge 缺席时按 RUNTIME_READY_WAIT_MS
    // = 120s 空等（正好撞上测试超时）。链路语义与就绪门无关，恒就绪即放行。
    dshBridge: { isReady: () => true },
    recordFleetTurnEvent: () => ({}),
    triggerFleetHandoffs: async (job, out) => {
      // mirror the server wiring against this fixture db
      const f = fleetDb.getFleet("f_chain");
      const memberId = job.origin?.fleet?.memberId ?? job.sourceTag?.memberId ?? null;
      const edges = outgoingHandoffs(f.orchestration, memberId);
      if (!edges.length) return null;
      const c = constraintsOf(f.orchestration);
      const depth = (job.origin?.fleet?.depth ?? 0) + 1;
      const results = [];
      for (const e of edges) {
        const target = fleetDb.getMember(e.to);
        if (depth > c.maxChainDepth) {
          fleetDb.appendTurnEvent({ fleetId: "f_chain", memberId: target.id, source: "manual", status: "failed", errorKind: "other", error: `handoff depth bound reached (${depth})`, startedAt: 1, endedAt: 2 });
          continue;
        }
        const task = engine.createManualTask({
          prompt: `接棒:${out.ok ? String(out.text).slice(0, 50) : out.error}`,
          persona: `t-${target.id}`,
          origin: { fleet: { fleetId: "f_chain", memberId: target.id, depth } },
          executionPolicy: { timeoutMinutes: c.budgetPerEdgeMin },
        });
        results.push(task.id);
      }
      created.push(...results);
      return results;
    },
  };
  attachCronRunner(ctx, {
    runPersona: async () => ({ ok: true, text: "上游产出 ABC" }),
    runA2a: async () => ({ ok: true }),
    listAgents: () => [],
  });

  await ctx.runCronJobTurn({ id: "j1", targetType: "persona", preset: "t-m_up", sourceTag: { fleetId: "f_chain", memberId: "m_up" } });
  assert.equal(created.length, 1);
  const t1 = engine.getTaskRecord(created[0]);
  assert.equal(t1.origin.fleet.depth, 1);
  assert.equal(t1.origin.fleet.memberId, "m_down");
  assert.equal(t1.executionPolicy.timeoutMinutes, 15);
  assert.ok(t1.prompt.includes("上游产出 ABC"));

  // failed upstream relays honestly: a fresh ctx whose persona turn fails
  // (spread copies don't reach attachCronRunner's closure — rebuild the ctx)
  const failCtx = {
    session: { model: { id: "m0" } },
    taskTurnRegistry: new Map(),
    // 运行时就绪门替身（同上）：缺席会按 120s 空等，撞上测试超时。
    dshBridge: { isReady: () => true },
    recordFleetTurnEvent: () => ({}),
    triggerFleetHandoffs: (job, out) => ctx.triggerFleetHandoffs(job, out),
  };
  attachCronRunner(failCtx, {
    runPersona: async () => ({ ok: false, error: "503: upstream unavailable" }),
    runA2a: async () => ({ ok: true }),
    listAgents: () => [],
  });
  await failCtx.runCronJobTurn({ id: "j3", targetType: "persona", preset: "t-m_up", sourceTag: { fleetId: "f_chain", memberId: "m_up" } });
  const last = engine.getTaskRecord(created[created.length - 1]);
  assert.ok(last.prompt.includes("503: upstream unavailable"), "failure relayed verbatim, no retry");
  await engine.idle?.();

  // over-bound: chain depth 3 > maxChainDepth 2 ⇒ no task, honest event row
  const before = created.length;
  await ctx.runCronJobTurn({ id: "j4", targetType: "persona", preset: "t-m_up", origin: { fleet: { fleetId: "f_chain", memberId: "m_up", depth: 2 } } });
  assert.equal(created.length, before, "no task over the bound");
  const refusal = fleetDb.listFleetTurnEvents("f_chain", { status: "failed" });
  assert.ok(refusal.some((e) => e.error.includes("depth bound reached")));
});

// ── 4. write face + cockpit read ────────────────────────────────────────────

test("routes: PATCH accepts a valid section, rejects a cycle; cockpit reads expanded; member delete drops edges", async () => {
  const fleet = fixtureFleet(fleetDb, { id: "f_w", members: [P("m_a"), P("m_b"), P("m_c")] });
  const { server, base } = await startServer({
    authEnabled: false, cellUserEmail: "owner@test",
    fleetTargetResolver: (m) => ({ alive: true, label: m.targetId }),
  });
  const call = (method, p, body) =>
    fetch(`${base}${p}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  try {
    const cyc = await call("PATCH", `/api/fleets/${fleet.id}`, { orchestration: { edges: [
      { kind: "handoff", from: "m_a", to: "m_b" }, { kind: "handoff", from: "m_b", to: "m_a" },
    ] } });
    assert.equal(cyc.status, 400);
    assert.ok(cyc.body.error.includes("cycle"));

    const ok = await call("PATCH", `/api/fleets/${fleet.id}`, { orchestration: {
      mode: "supervisor",
      edges: [{ kind: "handoff", from: "m_a", to: "m_b" }],
    } });
    assert.equal(ok.status, 200);

    const cock = await (await fetch(`${base}/api/fleets/${fleet.id}/cockpit`)).json();
    assert.equal(cock.orchestration.mode, "supervisor");
    assert.ok(cock.orchestration.edges.some((e) => e.kind === "dispatch" && e.implicit), "supervisor expansion visible");
    assert.ok(cock.orchestration.edges.some((e) => e.kind === "handoff" && e.from === "m_a"));

    // member delete drops dangling edges
    const del = await call("DELETE", `/api/fleets/${fleet.id}/members/m_b`);
    assert.equal(del.status, 200);
    const after = fleetDb.getFleet(fleet.id).orchestration;
    assert.equal(after.edges.length, 0, "both edges touched m_b and are gone");
  } finally {
    server.close();
  }
});

// ── 5. fanout edges (add-fleet-fanout) ─────────────────────────────────────

test("fanout validation: legal shape + every rejection class", () => {
  const members = [
    P("f_a"), P("f_b"), P("f_c"), P("f_j"),
    { id: "f_tool", title: "工具", parentId: null, targetKind: "tool", targetId: "s::t" },
    { id: "f_a2a", title: "远端", parentId: null, targetKind: "a2a", targetId: "agent-x" },
  ];
  const fan = (over = {}) => validateOrchestration({ members, orchestration: { edges: [
    { kind: "fanout", from: "f_a", targets: ["f_b", "f_c"], ...over.edge },
  ], ...(over.orch ?? {}) } });

  assert.equal(fan().ok, true, "default aggregate=all passes");
  assert.equal(fan({ edge: { targets: ["f_b"] } }).ok, false, "single target");
  assert.equal(fan({ edge: { targets: ["f_b", "f_b"] } }).ok, false, "duplicate target");
  assert.equal(fan({ edge: { targets: ["f_b", "f_a"] } }).ok, false, "self in targets");
  assert.equal(fan({ edge: { targets: ["f_b", "ghost"] } }).ok, false, "unknown target");
  assert.equal(fan({ edge: { targets: ["f_b", "f_tool"] } }).ok, false, "tool target");
  assert.equal(fan({ edge: { targets: ["f_b", "f_c"], aggregate: { kind: "weird" } } }).ok, false, "bad aggregate kind");
  assert.equal(fan({ edge: { targets: ["f_b", "f_c"], aggregate: { kind: "judge", judge: "f_a" } } }).ok, false, "judge is the fan source");
  assert.equal(fan({ edge: { targets: ["f_b", "f_c"], aggregate: { kind: "judge", judge: "f_b" } } }).ok, false, "judge is a target");
  assert.equal(fan({ edge: { targets: ["f_b", "f_c"], aggregate: { kind: "judge", judge: "f_a2a" } } }).ok, false, "a2a judge");
  assert.equal(fan({ edge: { targets: ["f_b", "f_c"], rounds: 5 } }).ok, false, "rounds over bound");
  assert.equal(fan({ edge: { targets: ["f_b", "f_c"], args: { x: 1 } } }).ok, false, "fanout takes no args");
  const judged = fan({ edge: { targets: ["f_b", "f_c"], aggregate: { kind: "judge", judge: "f_j" }, rounds: 2 } });
  assert.equal(judged.ok, true, "persona judge with rounds passes");
  // fanout loops stay out of the DAG walk: A→B handoff + B fanout back to A is legal
  const loop = validateOrchestration({ members, orchestration: { edges: [
    { kind: "handoff", from: "f_a", to: "f_b" },
    { kind: "fanout", from: "f_b", targets: ["f_a", "f_c"] },
  ] } });
  assert.equal(loop.ok, true, "fanout cycles are rounds/depth-bounded, not DAG-refused");
});

test("fanout seam: wave creation, initiator wiring both modes, failure relay, depth bound", async () => {
  const fleet = fleetDb.createFleet({ id: "f_fo", name: "扇出舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "fo_src", fleetId: fleet.id, title: "主编", targetKind: "persona", targetId: "p-src", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "fo_w1", fleetId: fleet.id, title: "撰稿A", targetKind: "persona", targetId: "p-w1", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "fo_w2", fleetId: fleet.id, title: "撰稿B", targetKind: "persona", targetId: "p-w2", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "fo_judge", fleetId: fleet.id, title: "评审", targetKind: "persona", targetId: "p-judge", kpiSlots: [], cadence: null });
  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [
    { kind: "fanout", from: "fo_src", targets: ["fo_w1", "fo_w2"], aggregate: { kind: "judge", judge: "fo_judge" } },
  ], constraints: { maxChainDepth: 2, budgetPerEdgeMin: 12 } } });

  const created = [];
  const ctx = {
    session: { model: { id: "m0" } },
    taskTurnRegistry: new Map(),
    // 运行时就绪门替身：舰队任务在 dshBridge 缺席时按 RUNTIME_READY_WAIT_MS
    // = 120s 空等（正好撞上测试超时）。链路语义与就绪门无关，恒就绪即放行。
    dshBridge: { isReady: () => true },
    recordFleetTurnEvent: () => ({}),
    triggerFleetHandoffs: async (job, out) => {
      // mirror the server wiring (fanout half)
      const f = fleetDb.getFleet("f_fo");
      const memberId = job.origin?.fleet?.memberId ?? job.sourceTag?.memberId;
      const edges = (f.orchestration.edges ?? []).filter((e) => e.kind === "fanout" && e.from === memberId);
      if (!edges.length) return null;
      const c = constraintsOf(f.orchestration);
      const depth = (job.origin?.fleet?.depth ?? 0) + 1;
      const now = Date.now();
      const dispatched = [];
      for (const e of edges) {
        const agg = e.aggregate ?? { kind: "all" };
        const judge = agg.kind === "judge" ? fleetDb.getMember(agg.judge) : null;
        const summary = out?.ok === true ? String(out.text).slice(0, 100) : `上游回合失败:${String(out.error).slice(0, 60)}`;
        for (const t of e.targets ?? []) {
          const target = fleetDb.getMember(t);
          if (!target) continue;
          if (depth > c.maxChainDepth) {
            fleetDb.appendTurnEvent({ fleetId: "f_fo", memberId: t, source: "manual", status: "failed", errorKind: "other", error: `fanout depth bound reached (${depth})`, startedAt: now, endedAt: now });
            continue;
          }
          const task = engine.createManualTask({
            prompt: `扇出:${summary}`,
            persona: `t-${target.id}`,
            sessionTitle: `扇出 · ${target.title}`,
            origin: { fleet: { fleetId: "f_fo", memberId: t, depth, wave: 1 } },
            ...(judge ? { initiator: `fleet:f_fo:${judge.id}`, initiatorPreset: `t-${judge.id}` } : { initiator: job.sessionId ?? null }),
            executionPolicy: { timeoutMinutes: c.budgetPerEdgeMin },
          });
          created.push(task.id);
          dispatched.push(task.id);
        }
      }
      return dispatched;
    },
  };
  attachCronRunner(ctx, {
    runPersona: async () => ({ ok: true, text: "主编的题目" }),
    runA2a: async () => ({ ok: true }),
    listAgents: () => [],
  });

  await ctx.runCronJobTurn({ id: "j1", targetType: "persona", preset: "p-src", sessionId: "sess-src", sourceTag: { fleetId: "f_fo", memberId: "fo_src" } });
  assert.equal(created.length, 2, "one manual turn per target");
  for (const id of created) {
    const t = engine.getTaskRecord(id);
    assert.equal(t.origin.fleet.wave, 1);
    assert.equal(t.initiator, "fleet:f_fo:fo_judge", "judge wiring: synthetic fleet-scoped initiator");
    assert.equal(t.initiatorPreset, "t-fo_judge");
    assert.ok(t.prompt.includes("主编的题目"));
    assert.equal(t.executionPolicy.timeoutMinutes, 12);
  }

  // no-judge wiring + failure relay + depth bound in one deeper pass
  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [
    { kind: "fanout", from: "fo_src", targets: ["fo_w1", "fo_w2"] },
  ], constraints: { maxChainDepth: 2, budgetPerEdgeMin: 10 } } });
  created.length = 0;
  const _failCtx = { ...ctx, triggerFleetHandoffs: (job, out) => ctx.triggerFleetHandoffs(job, out) };
  // 运行时就绪门替身：failBind 是全新对象（不继承 ctx），缺席会按
  // RUNTIME_READY_WAIT_MS = 120s 空等，正好撞上测试超时。
  const failBind = { dshBridge: { isReady: () => true } };
  attachCronRunner(failBind, {
    runPersona: async () => ({ ok: false, error: "429 upstream gone" }),
    runA2a: async () => ({ ok: true }),
    listAgents: () => [],
  });
  failBind.triggerFleetHandoffs = (job) => ctx.triggerFleetHandoffs(job, { ok: false, error: "429 upstream gone" });
  await failBind.runCronJobTurn({ id: "j2", targetType: "persona", preset: "p-src", sessionId: "sess-src", sourceTag: { fleetId: "f_fo", memberId: "fo_src" } });
  assert.equal(created.length, 2);
  for (const id of created) {
    const t = engine.getTaskRecord(id);
    assert.equal(t.initiator, "sess-src", "no judge: the upstream session aggregates");
    assert.ok(t.prompt.includes("429 upstream gone"), "failure relayed verbatim");
  }

  // depth bound: upstream at depth 2 → nextDepth 3 > maxChainDepth 2 ⇒ refusal rows
  created.length = 0;
  await ctx.runCronJobTurn({ id: "j3", targetType: "persona", preset: "p-src", origin: { fleet: { fleetId: "f_fo", memberId: "fo_src", depth: 2 } } });
  assert.equal(created.length, 0, "no wave over the depth bound");
  assert.ok(fleetDb.listFleetTurnEvents("f_fo", { status: "failed" }).some((e) => e.error.includes("fanout depth bound")));
  await engine.idle?.();
});

// ── 5. cockpit design-mode draft lane (add-fleet-cockpit-v2 group D) ────────

test("cockpit draft/apply: same judgment as the bridge, subset-guarded, owner-gated", async () => {
  fixtureFleet(fleetDb, { id: "f_dm", members: [P("m_a"), P("m_b"), P("m_c")] });
  const { server, base } = await startServer({
    authEnabled: false, cellUserEmail: "owner@test", currentPreset: "t-m_a",
    fleetTargetResolver: (m) => ({ alive: true, label: m.targetId }),
  });
  const post = async (path, body) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  try {
    // Subset guard: structural moves stay on the architect lane.
    assert.equal((await post("/api/fleets/f_dm/orchestration/draft", { members: [{ op: "add", title: "x", targetKind: "persona", targetId: "p" }] })).status, 400);
    assert.equal((await post("/api/fleets/f_dm/orchestration/draft", { fleet: { name: "改名" } })).status, 400);
    assert.equal((await post("/api/fleets/f_dm/orchestration/draft", { members: [{ ref: "m_a", op: "update", title: "新题" }] })).status, 400);

    // In-subset draft validates, diffs, estimates — and persists nothing.
    const edges = { mode: "pipeline", edges: [{ kind: "handoff", from: "m_a", to: "m_b" }] };
    const cadence = { cron: "0 9 * * *", tz: null, promptTemplate: "报数", enabled: true };
    const draft = { fleet: { orchestration: edges }, members: [{ ref: "m_a", op: "update", cadence }] };
    const dry = await post("/api/fleets/f_dm/orchestration/draft", draft);
    assert.equal(dry.status, 200);
    assert.equal(dry.body.ok, true);
    assert.equal(fleetDb.getFleet("f_dm").orchestration, null, "dry-run persists nothing");
    assert.equal(fleetDb.getMember("m_a").cadence, null);

    // Apply lands orchestration + cadence (reconcile rides along).
    const applied = await post("/api/fleets/f_dm/orchestration/apply", draft);
    assert.equal(applied.status, 200);
    assert.equal(applied.body.ok, true);
    assert.deepEqual(fleetDb.getFleet("f_dm").orchestration.edges.map((e) => [e.kind, e.from, e.to]), [["handoff", "m_a", "m_b"]]);
    assert.deepEqual(fleetDb.getMember("m_a").cadence, cadence);

    // A cyclic draft is rejected by BOTH doors with the same verdict — the
    // route calls the same validateFleetDraft the bridge does.
    const cyclic = { fleet: { orchestration: { mode: "pipeline", edges: [
      { kind: "handoff", from: "m_a", to: "m_b" }, { kind: "handoff", from: "m_b", to: "m_a" },
    ] } } };
    const viaRoute = await post("/api/fleets/f_dm/orchestration/draft", cyclic);
    assert.equal(viaRoute.body.ok, false);
    const viaFn = validateFleetDraft(fleetDb, { mode: "edit", fleetId: "f_dm", ...cyclic });
    assert.equal(viaFn.ok, false);
    assert.equal(
      JSON.stringify(viaRoute.body.errors.map((e) => e.error).sort()),
      JSON.stringify(viaFn.errors.map((e) => e.error).sort()),
      "two doors, one judgment",
    );
    assert.equal((await post("/api/fleets/f_dm/orchestration/apply", cyclic)).status, 409);

    // Drift: a validated draft whose edge target vanishes before apply fails
    // honestly, naming the drift.
    const driftDraft = { fleet: { orchestration: { mode: "pipeline", edges: [{ kind: "handoff", from: "m_a", to: "m_c" }] } } };
    assert.equal((await post("/api/fleets/f_dm/orchestration/draft", driftDraft)).body.ok, true);
    fleetDb.deleteMember("m_c");
    const drifted = await post("/api/fleets/f_dm/orchestration/apply", driftDraft);
    assert.equal(drifted.status, 409);
    assert.ok(JSON.stringify(drifted.body.errors).includes("m_c"));

    // Cockpit design mode edits orchestration only: the body carries no
    // `members` at all, and that must not read as a broken draft.
    const beforePosts = fleetDb.listMembers("f_dm").map((m) => m.id).sort();
    const orchOnly = { fleet: { orchestration: { mode: "supervisor", constraints: { maxChainDepth: 2, budgetPerEdgeMin: 10 } } } };
    assert.equal((await post("/api/fleets/f_dm/orchestration/draft", orchOnly)).body.ok, true);
    const orchApplied = await post("/api/fleets/f_dm/orchestration/apply", orchOnly);
    assert.equal(orchApplied.status, 200, JSON.stringify(orchApplied.body.errors ?? []));
    assert.equal(fleetDb.getFleet("f_dm").orchestration.mode, "supervisor");
    assert.deepEqual(fleetDb.listMembers("f_dm").map((m) => m.id).sort(), beforePosts, "posts untouched by an orchestration-only draft");
  } finally {
    server.close();
  }
});

test("cockpit draft lane: ownership identical to the fleet face (403 foreign, 401 anonymous)", async () => {
  fixtureFleet(fleetDb, { id: "f_own", members: [P("m_a")] });
  const stranger = await startServer({ authEnabled: false, cellUserEmail: "stranger@test", fleetTargetResolver: (m) => ({ alive: true, label: m.targetId }) });
  const anon = await startServer({ authEnabled: true, fleetTargetResolver: (m) => ({ alive: true, label: m.targetId }) });
  const body = { fleet: { orchestration: { mode: "pipeline", edges: [] } } };
  try {
    for (const base of [stranger.base, anon.base]) {
      const r = await fetch(`${base}/api/fleets/f_own/orchestration/draft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.ok(r.status === 403 || r.status === 401, `gate reads ${r.status}`);
      const a = await fetch(`${base}/api/fleets/f_own/orchestration/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.ok(a.status === 403 || a.status === 401);
    }
    assert.equal(fleetDb.getFleet("f_own").orchestration, null, "nothing written through either rejection");
  } finally {
    stranger.server.close();
    anon.server.close();
  }
});

// ── 6. the REAL seam (server/fleet-handoffs.js) — the in-stub mirror above
// self-consistently missed the fanout-only early-return for years; these pin
// the imported function so the stub can never diverge again (挂账取证班).
const { igniteFleetEdges } = await import("../server/fleet-handoffs.js");

test("REAL seam: a fanout-ONLY source ignites its wave (the dead-shape regression)", async () => {
  const fleet = fleetDb.createFleet({ id: "f_fo2", name: "纯扇出舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "fo2_src", fleetId: fleet.id, title: "源头", targetKind: "persona", targetId: "p-s2", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "fo2_w1", fleetId: fleet.id, title: "波A", targetKind: "persona", targetId: "p-w3", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "fo2_w2", fleetId: fleet.id, title: "波B", targetKind: "persona", targetId: "p-w4", kpiSlots: [], cadence: null });
  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [
    // NO handoff edge on fo_src — the shape the early return killed.
    { kind: "fanout", from: "fo2_src", targets: ["fo2_w1", "fo2_w2"], aggregate: { kind: "all" } },
  ], constraints: { maxChainDepth: 2 } } });

  const created = await igniteFleetEdges({
    db: fleetDb, engine,
    job: { id: "j-fo2", sessionId: "sess-fo2", sourceTag: { fleetId: fleet.id, memberId: "fo2_src" }, origin: { fleet: { fleetId: fleet.id, memberId: "fo2_src", depth: 0 } } },
    out: { ok: true, text: "上游产出" },
  });
  assert.equal(created.length, 2, "the wave ignites from a fanout-only source");
  for (const { taskId } of created) {
    const t = engine.getTaskRecord(taskId);
    assert.equal(t.origin.fleet.depth, 1);
    assert.equal(t.initiator, "sess-fo2", "no-judge wave carries the upstream session");
  }
});

test("REAL seam: fanout depth bound writes honest rows with the derived-lane carrier marking", async () => {
  const fleet = fleetDb.createFleet({ id: "f_fo3", name: "越界扇出舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "fo3_src", fleetId: fleet.id, title: "源", targetKind: "persona", targetId: "p-s3", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "fo3_t1", fleetId: fleet.id, title: "靶1", targetKind: "persona", targetId: "p-t1", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "fo3_t2", fleetId: fleet.id, title: "靶2", targetKind: "a2a", targetId: "agent-x", kpiSlots: [], cadence: null });
  fleetDb.updateMember("fo3_t1", { carrier: "worker" });
  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [
    { kind: "fanout", from: "fo3_src", targets: ["fo3_t1", "fo3_t2"], aggregate: { kind: "all" } },
  ], constraints: { maxChainDepth: 1 } } });

  // Ignition at depth 1 (a handoff-delegated source): the wave would land at
  // depth 2 > 1 — bound rows, no tasks.
  const created = await igniteFleetEdges({
    db: fleetDb, engine,
    job: { id: "j-fo3", sessionId: "sess-fo3", origin: { fleet: { fleetId: fleet.id, memberId: "fo3_src", depth: 1 } } },
    out: { ok: false, error: "model_upstream 503" },
  });
  assert.equal(created, null, "over-bound hops create no tasks");
  const d = fleetDb.db ?? fleetDb;
  try {
    const rows = d.prepare("SELECT member_id, source, status, carrier, carrier_instance, error FROM member_turn_events WHERE fleet_id = 'f_fo3' ORDER BY id").all();
    assert.equal(rows.length, 2, "one honest row per bound target");
    const byMember = Object.fromEntries(rows.map((r) => [r.member_id.slice(-4), r]));
    assert.equal(byMember["3_t1"].carrier, "worker", "persona target marks its resolved lane");
    assert.equal(byMember["3_t1"].carrier_instance, null, "nothing claimed a body");
    assert.equal(byMember["3_t2"].carrier, "remote", "a2a target marks the remote lane");
    assert.match(byMember["3_t1"].error, /fanout depth bound reached \(2 > 1\)/);
  } finally { /* shared handle — not closed */ }
});

// ── 7. edge context token (add-fleet-edge-context D1) ───────────────────────
//
// Every edge turn was handed a hand-built prompt with no fleet view; the seams
// now carry {{fleetEdgeContext}} for persona targets. Pinned at the REAL seam
// so a future prompt edit cannot silently drop it again, and pinned for a2a /
// tool targets so the token never leaks into another service's message or a
// tool post's JSON arguments.

test("REAL seam: handoff and fanout prompts carry the edge-context token for persona targets only", async () => {
  const fleet = fleetDb.createFleet({ id: "f_ctx", name: "边上下文舰", ownerEmail: "owner@test" });
  for (const [id, kind] of [["ctx_src", "persona"], ["ctx_persona", "persona"], ["ctx_a2a", "a2a"]]) {
    fleetDb.createMember({ id, fleetId: fleet.id, title: id, targetKind: kind, targetId: `t-${id}`, kpiSlots: [], cadence: null });
  }
  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [
    { kind: "handoff", from: "ctx_src", to: "ctx_persona" },
    { kind: "handoff", from: "ctx_src", to: "ctx_a2a" },
  ], constraints: { maxChainDepth: 3 } } });

  const created = await igniteFleetEdges({
    db: fleetDb, engine,
    job: { id: "j-ctx", sessionId: "sess-ctx", origin: { fleet: { fleetId: fleet.id, memberId: "ctx_src", depth: 0 } } },
    out: { ok: true, text: "上游结果" },
  });
  const byTarget = Object.fromEntries(created.map(({ to, taskId }) => [to, engine.getTaskRecord(taskId)]));
  assert.match(byTarget.ctx_persona.prompt, /\{\{fleetEdgeContext\}\}$/, "persona handoff asks for the fleet view");
  assert.equal(byTarget.ctx_a2a.prompt.includes("{{fleetEdgeContext}}"), false, "a2a is another service — no token");

  const wave = await igniteFleetEdges({
    db: fleetDb, engine,
    job: { id: "j-ctx2", sessionId: "sess-ctx2", origin: { fleet: { fleetId: fleet.id, memberId: "ctx_persona", depth: 0 } } },
    out: { ok: true, text: "上游结果2" },
  });
  // ctx_persona has no outgoing edges → null; drive a wave from ctx_src instead.
  assert.ok(wave === null || wave.length === 0, "no outgoing edges from the leaf");

  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [
    { kind: "fanout", from: "ctx_src", targets: ["ctx_persona", "ctx_a2a"], aggregate: { kind: "all" } },
  ], constraints: { maxChainDepth: 3 } } });
  const wave2 = await igniteFleetEdges({
    db: fleetDb, engine,
    job: { id: "j-ctx3", sessionId: "sess-ctx3", origin: { fleet: { fleetId: fleet.id, memberId: "ctx_src", depth: 0 } } },
    out: { ok: true, text: "上游结果3" },
  });
  const w = Object.fromEntries(wave2.map(({ to, taskId }) => [to, engine.getTaskRecord(taskId)]));
  assert.match(w.ctx_persona.prompt, /\{\{fleetEdgeContext\}\}$/, "persona fanout asks for the fleet view");
  assert.equal(w.ctx_a2a.prompt.includes("{{fleetEdgeContext}}"), false, "a2a fanout stays token-free");
});

// ── 8. ignition idempotence (add-fleet-ignition-idem) ───────────────────────
//
// The seam is reachable more than once for one turn (a retried execution, a
// second finish callback, a resumed round). Before this, each re-entry created
// another wave of downstream turns — the same work paid for twice. The hop key
// is (upstream turn, edge kind, target); a NEW turn ignites again by design,
// otherwise an operator could never re-drive a chain.

test("REAL seam: re-entering ignition for the same turn creates nothing the second time", async () => {
  const fleet = fleetDb.createFleet({ id: "f_idem", name: "幂等舰", ownerEmail: "owner@test" });
  for (const id of ["id_src", "id_a", "id_b"]) {
    fleetDb.createMember({ id, fleetId: fleet.id, title: id, targetKind: "persona", targetId: `t-${id}`, kpiSlots: [], cadence: null });
  }
  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [
    { kind: "handoff", from: "id_src", to: "id_a" },
    { kind: "fanout", from: "id_src", targets: ["id_b"], aggregate: { kind: "all" } },
  ], constraints: { maxChainDepth: 3 } } });

  const job = { id: "j_idem", sessionId: "sess-idem", roundSeq: 1, origin: { fleet: { fleetId: fleet.id, memberId: "id_src", depth: 0 } } };
  const ledgerTurn = { turnId: "turn_idem_1" };
  const first = await igniteFleetEdges({ db: fleetDb, engine, job, ledgerTurn, out: { ok: true, text: "上游产出" } });
  assert.equal(first.length, 2, "one handoff hop + one fanout hop");

  // Same turn, second entry: nothing new.
  const again = await igniteFleetEdges({ db: fleetDb, engine, job, ledgerTurn, out: { ok: true, text: "上游产出" } });
  assert.equal(again, null, "a repeated ignition for the same turn creates nothing");

  // Provenance: every ignited task names the hop that produced it.
  for (const { taskId } of first) {
    assert.match(engine.getTaskRecord(taskId).origin.fleet.ignition, /^turn_idem_1:(handoff|fanout):id_/);
  }

  // A genuine new turn (operator re-run / next cadence round) ignites again.
  const nextTurn = await igniteFleetEdges({ db: fleetDb, engine, job, ledgerTurn: { turnId: "turn_idem_2" }, out: { ok: true, text: "重跑产出" } });
  assert.equal(nextTurn.length, 2, "a different turn is a different ignition — re-driving a chain stays possible");

  // Without a ledger the engine's per-execution sequence is the turn identity,
  // so the same execution still dedupes.
  const bJob = { id: "j_idem2", sessionId: "sess-idem2", roundSeq: 7, origin: { fleet: { fleetId: fleet.id, memberId: "id_src", depth: 0 } } };
  const a1 = await igniteFleetEdges({ db: fleetDb, engine, job: bJob, out: { ok: true, text: "x" } });
  const a2 = await igniteFleetEdges({ db: fleetDb, engine, job: bJob, out: { ok: true, text: "x" } });
  assert.equal(a1.length, 2);
  assert.equal(a2, null, "same execution, no ledger → still one ignition");
  const a3 = await igniteFleetEdges({ db: fleetDb, engine, job: { ...bJob, roundSeq: 8 }, out: { ok: true, text: "x" } });
  assert.equal(a3.length, 2, "the next execution is the next turn");
});

// ── 派发也认自报身份（2026-11-13）──────────────────────────────────────────────
//
// 起因：幕僚长的每日回合现在会向评审官/侦查官/书记派活，而 08:30 正是多舰队
// cadence 齐响的窗口。`/report` 早就有"服务端写入的岗位坐标"这条路，`/dispatch`
// 没有——并发时它只能靠"唯一在飞回合"，被判 ambiguous 就 409，派活时灵时不灵。
// 这两条钉住：并发下带自报坐标的派发被采纳；伪造坐标不被采纳。

test("dispatch bridge: 并发下自报身份仍能定位发起岗（与 /report 同一条优先级）", async () => {
  const f = fixtureFleet(fleetDb, {
    id: "f_attr",
    members: [P("m_a"), P("m_b")],
    orchestration: { mode: "supervisor" },
  });
  chatHistory.setSessionManager({ getSessionId: () => "sess-x" });

  // 两个"在飞回合" ⇒ 旧的唯一回合判定必然弃权（ambiguous）。
  const { server, base } = await startServer({
    authEnabled: false,
    cellUserEmail: "owner@test",
    currentPreset: null,
    // 两个在飞回合：路由从 ctx.fleetTurnLedger.openTurns() 取，不是从 ctx 上直接读函数。
    fleetTurnLedger: {
      openTurns: () => [
        { fleetId: f.id, memberId: "m_a", turnId: "turn_1" },
        { fleetId: f.id, memberId: "m_b", turnId: "turn_2" },
      ],
    },
    fleetTargetResolver: (m) => ({ alive: true, label: m.targetId, clusterName: null }),
  });
  const call = (body) =>
    fetch(`${base}/api/fleets/dispatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    // 不带自报 ⇒ 并发下必须拒（不是猜）
    const bare = await call({ to: "m_b", brief: "x" });
    assert.equal(bare.status, 409, "并发 + 无自报 ⇒ 拒收");
    assert.match(String(bare.body.error || ""), /several rounds are in flight|in flight/i);

    // 带正确自报 ⇒ 采纳，发起岗就是自报的那个
    const self = await call({
      to: "m_b",
      brief: "x",
      selfIdentity: { fleetId: f.id, memberId: "m_a", persona: P("m_a").targetId },
    });
    assert.equal(self.status, 201, "并发 + 正确自报 ⇒ 采纳");
    const task = engine.getTaskRecord(self.body.taskId);
    // 落库的是归一后的 roster id（点号/下划线都折成连字符），不是原始 targetId。
    assert.equal(task.initiatorPreset, "t-m-a", "汇总结论要说发起岗的话");

    // 伪造（memberId 存在但 persona 对不上）⇒ 当作没自报，回到拒收
    const forged = await call({
      to: "m_b",
      brief: "x",
      selfIdentity: { fleetId: f.id, memberId: "m_a", persona: "somebody-else" },
    });
    assert.equal(forged.status, 409, "坐标与岗位不符时不得采纳");
  } finally {
    server.close();
  }
});
