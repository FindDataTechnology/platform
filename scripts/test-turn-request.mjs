// Unit tests for the turn contract (agent-turn-contract).
//
// Covers the spec pins:
//   - buildTurnRequest derivation matrix over every existing turn path:
//     cron fleet post / plain non-fleet cron (schedule trigger, no tag) /
//     execute-now origin / delegation initiator (resultSink=caller) / a2a
//     (depth 1) / plain manual / budget + evidence pass-through
//   - assertTurnRequest: reserved source (peer→O3) fails with the destination
//     sink (blackboard→O5) fail structurally WITH the destination named;
//     depth bound 1; legal values pass
//   - single derivation source: turnSourceFor and recordTurnEvent's event
//     source come from the same rule (O1 behavior byte-identical)
//
// Run: node --test scripts/test-turn-request.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "turn-contract-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const chatHistory = await import("../chat-history.js");
const { initDb } = await import("../db.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const {
  buildTurnRequest,
  assertTurnRequest,
  SOURCES,
  RESULT_SINKS,
  DISPATCH_DEPTH_BOUND,
  DEFAULT_MAX_CHAIN_DEPTH,
} = await import("../server/turn-request.js");
const { recordTurnEvent, turnSourceFor } = await import("../server/fleet-events.js");

await initDb();
await chatHistory.initChatHistory();

test.after(async () => {
  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let fleetDb;
beforeEach(() => {
  fleetDb = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
  setFleetDatabase(fleetDb);
});

// ── derivation matrix ───────────────────────────────────────────────────────

test("derive: cron fleet post → cron/report/depth0, evidence carries sourceTag", () => {
  const r = buildTurnRequest({
    trigger: "schedule",
    targetType: "persona",
    preset: "persona-a",
    prompt: "报数",
    sourceTag: { fleetId: "f1", memberId: "m1" },
    sessionId: "s1",
  });
  assert.equal(r.source, "cron");
  assert.deepEqual(r.targetRef, { kind: "persona", id: "persona-a" });
  assert.equal(r.brief, "报数");
  assert.deepEqual(r.evidence.sourceTag, { fleetId: "f1", memberId: "m1" });
  assert.equal(r.resultSink, "report");
  assert.equal(r.depth, 0);
  assert.equal(r.budget, null);
});

test("derive: dispatch wake (initiator + origin) reads delegation, not manual", () => {
  const r = buildTurnRequest({
    trigger: "manual",
    targetType: "persona",
    preset: "p",
    prompt: "brief",
    initiator: "sess-dispatcher",
    origin: { fleet: { fleetId: "f", memberId: "m_target", depth: 1 } },
  });
  assert.equal(r.source, "delegation", "initiator outranks origin — a dispatch IS a delegation wake");
  assert.equal(r.resultSink, "caller");
  assert.equal(r.depth, 1, "chain position rides origin.fleet.depth");
});

test("derive: execute-now manual → manual, evidence carries origin", () => {
  const r = buildTurnRequest({
    trigger: "manual",
    targetType: "persona",
    preset: "persona-a",
    prompt: "拍板送达",
    origin: { fleet: { fleetId: "f1", memberId: "m_passive" } },
  });
  assert.equal(r.source, "manual");
  assert.equal(r.evidence.origin.fleet.memberId, "m_passive");
  assert.equal(r.evidence.sourceTag, undefined);
  assert.equal(r.resultSink, "report", "no initiator ⇒ the report lane, not caller");
});

test("derive: delegation wake → delegation/caller — the aggregator fact, named", () => {
  const r = buildTurnRequest({
    trigger: "manual",
    targetType: "persona",
    preset: "persona-b",
    prompt: "去写一篇",
    initiator: "sess-9",
  });
  assert.equal(r.source, "delegation");
  assert.equal(r.evidence.initiator, "sess-9");
  assert.equal(r.resultSink, "caller");
  assert.equal(r.depth, 0);
});

test("derive: a2a remote turn → depth 1, cron or delegation per its lane", () => {
  const cronPost = buildTurnRequest({
    trigger: "schedule",
    targetType: "a2a",
    preset: "agent-x",
    sourceTag: { fleetId: "f1", memberId: "m_a" },
  });
  assert.equal(cronPost.source, "cron");
  assert.equal(cronPost.depth, 1);

  const delegated = buildTurnRequest({
    trigger: "manual",
    targetType: "a2a",
    preset: "agent-x",
    initiator: "sess-1",
  });
  assert.equal(delegated.source, "delegation");
  assert.equal(delegated.resultSink, "caller");
  assert.equal(delegated.depth, 1, "remote delegation carries the depth-1 header fact");
});

test("derive: non-fleet cron reads cron even with no fleet tag; plain manual reads manual", () => {
  assert.equal(buildTurnRequest({ trigger: "schedule", targetType: "persona", preset: "p" }).source, "cron");
  assert.equal(buildTurnRequest({ trigger: "manual", targetType: "persona", preset: "p" }).source, "manual");
  assert.deepEqual(buildTurnRequest({ trigger: "manual", preset: "p" }).evidence, {});
});

test("derive: budget passes through executionPolicy; pure — no IO observed", () => {
  const r = buildTurnRequest({
    trigger: "schedule",
    targetType: "cluster",
    preset: "c1",
    executionPolicy: { timeoutMinutes: 25 },
  });
  assert.deepEqual(r.budget, { minutes: 25 });
  assert.equal(r.targetRef.kind, "cluster");
});

// ── value bounds ────────────────────────────────────────────────────────────

test("assertTurnRequest: reserved values fail with their destination named", () => {
  const peer = assertTurnRequest({ source: "peer", resultSink: "report", depth: 0 });
  assert.ok(peer.error.includes("O3"), "peer names the dispatch destination");
  // event UNRESERVED (add-fleet-event-wake): a legal source now — only peer
  // remains reserved. The old refusal assertion flipped to a legality one.
  const event = assertTurnRequest({ source: "event", resultSink: "report", depth: 0 });
  assert.equal(event, null, "event is a legal source since the bot-inbound binding");
  const bb = assertTurnRequest({ source: "cron", resultSink: "blackboard", depth: 0 });
  assert.ok(bb.error.includes("O5"), "blackboard names the shared-state destination");

  assert.equal(assertTurnRequest({ source: "cron", resultSink: "report", depth: 0 }), null);
  assert.equal(assertTurnRequest({ source: "delegation", resultSink: "caller", depth: 1 }), null);
  assert.ok(assertTurnRequest({ source: "mystery", resultSink: "report", depth: 0 }).error.includes("must be one of"));

  assert.equal(DISPATCH_DEPTH_BOUND, 1);
  assert.ok(assertTurnRequest({ source: "cron", resultSink: "report", depth: 2 }).error.includes("0..1"), "no chain bound ⇒ dispatch lane bound applies");
  assert.ok(SOURCES.length === 4 && RESULT_SINKS.length === 2, "cron|manual|delegation|event × report|caller");

  // Per-lane depth (add-fleet-orchestration 1.3): dispatch lane hard-bounds at
  // 1; a declared chain bound lifts the handoff lane to maxChainDepth.
  const lane = { source: "manual", resultSink: "report" };
  assert.equal(assertTurnRequest({ ...lane, depth: 3 }, { maxChainDepth: 5 }), null, "declared chain admits mid-chain depth");
  assert.ok(assertTurnRequest({ ...lane, depth: 6 }, { maxChainDepth: 5 }).error.includes("declared chain bound"));
  assert.ok(assertTurnRequest({ ...lane, depth: 2 }, { maxChainDepth: 1 }).error.includes("0..1"), "chain bound never lowers the dispatch floor");
  assert.equal(DEFAULT_MAX_CHAIN_DEPTH, 8);
});

// ── single derivation source ────────────────────────────────────────────────

test("one rule, two doors: turnSourceFor and recordTurnEvent agree per lane", () => {
  const fleet = fleetDb.createFleet({ id: "f_one", name: "一号", ownerEmail: "owner@test" });
  fleetDb.createMember({
    id: "m_passive", fleetId: fleet.id, title: "被动岗", targetKind: "persona",
    targetId: "persona-passive", kpiSlots: [], cadence: null,
  });

  const lanes = [
    { job: { trigger: "schedule", sourceTag: { fleetId: fleet.id, memberId: "m_x" } }, want: "cron" },
    { job: { trigger: "manual", origin: { fleet: { fleetId: fleet.id, memberId: "m_x" } } }, want: "manual" },
    { job: { trigger: "manual", preset: "persona-passive", initiator: "s" }, want: "delegation" },
    { job: { trigger: "manual", preset: "persona-passive" }, want: "manual" },
  ];
  for (const { job, want } of lanes) {
    assert.equal(turnSourceFor(job), want);
    const ev = recordTurnEvent(fleetDb, job, { ok: true }, { startedAt: 1, endedAt: 2 });
    if (ev) assert.equal(ev.source, want, "the event reads the same derivation");
  }

  // zero disturbance stays: a stranger turn derives, records nothing
  assert.equal(recordTurnEvent(fleetDb, { trigger: "manual", preset: "stranger" }, { ok: true }, { startedAt: 1, endedAt: 2 }), null);
});

// ── chain (agent-fleet-runs / agent-turn-contract v2) ───────────────────────

test("derive: root cron turn carries no chain; derivation mints nothing", () => {
  const job = { trigger: "schedule", sourceTag: { fleetId: "f1", memberId: "m_root" } };
  const a = buildTurnRequest(job);
  const b = buildTurnRequest(job);
  assert.equal(a.chain, null);
  assert.deepEqual(a, b, "pure: deriving twice yields the same value object");
  assert.equal(a.source, "cron");
});

test("derive: dispatched task carries chain edgeKind=dispatch, source=delegation", () => {
  const job = {
    trigger: "manual",
    preset: "persona-passive",
    initiator: "sess-dispatcher",
    origin: { fleet: { fleetId: "f1", memberId: "m_target", depth: 1, chain: { runId: "run_abc", parentTurnId: "turn_up", edgeKind: "dispatch" } } },
  };
  const r = buildTurnRequest(job);
  assert.equal(r.source, "delegation");
  assert.deepEqual(r.chain, { runId: "run_abc", parentTurnId: "turn_up", edgeKind: "dispatch" });
  assert.equal(r.resultSink, "caller");
});

test("derive: handoff task inherits the upstream run and names edgeKind=handoff", () => {
  const job = {
    trigger: "manual",
    preset: "persona-b",
    origin: { fleet: { fleetId: "f1", memberId: "m_down", depth: 2, chain: { runId: "run_abc", parentTurnId: "turn_up", edgeKind: "handoff" } } },
  };
  const r = buildTurnRequest(job);
  assert.equal(r.chain.runId, "run_abc");
  assert.equal(r.chain.parentTurnId, "turn_up");
  assert.equal(r.chain.edgeKind, "handoff");
  assert.equal(r.depth, 2);
});

test("derive: malformed chain is dropped, unknown edgeKind reads null; event wake is a root", () => {
  assert.equal(buildTurnRequest({ trigger: "manual", origin: { fleet: { fleetId: "f1", memberId: "m", chain: { parentTurnId: "x" } } } }).chain, null, "no runId → no chain");
  const odd = buildTurnRequest({ trigger: "manual", origin: { fleet: { fleetId: "f1", memberId: "m", chain: { runId: "run_1", edgeKind: "teleport" } } } });
  assert.deepEqual(odd.chain, { runId: "run_1", parentTurnId: null, edgeKind: null });
  const wake = buildTurnRequest({ trigger: "manual", origin: { fleet: { fleetId: "f1", memberId: "m", depth: 0 }, event: { botId: "b1" } } });
  assert.equal(wake.source, "event");
  assert.equal(wake.chain, null);
});
