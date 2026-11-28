#!/usr/bin/env node
// ── Reassignment / team takeover (add-task-flow, tasks 4.1–4.2)
//
// The property under test is the one that makes "another team takes over" safe:
// a takeover is an IN-PLACE rewrite. Task id, bound session and execution
// history are the card's identity; if any of them move, the next process looks
// for something that no longer exists and the card is lost in the gap.
//
//   node --test scripts/test-task-flow-reassign.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "task-flow-reassign-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const flow = await import("../server/task-flow.js");
const { createTaskFlowDatabase } = await import("../server/task-flow-db.js");
const engine = await import("../task-engine.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const stationA = { stationId: "draft", acceptance: [{ id: "a1", kind: "artifact-exists", target: "draft.md" }] };
const stationB = { stationId: "review", acceptance: [{ id: "b1", kind: "command-succeeds", target: "npm test" }] };

// ── 4.1 in-place rewrite ─────────────────────────────────────────────────────

test("reassign: task id, session and history are untouched", async () => {
  await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });
  const created = engine.createManualTask({ prompt: "draft the report", persona: "p1", flow: flow.stampAcceptance({ flowId: "content" }, stationA) });
  // Manual tasks enqueue on creation, so the turn settles asynchronously. Wait
  // for it: a snapshot taken mid-execution would compare against a history that
  // grew for a reason unrelated to the reassignment (the test's own race).
  for (let i = 0; i < 100 && (engine.getRecord(created.id)?.history ?? []).length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const before = engine.getRecord(created.id);
  assert.ok(before.history.length > 0, "the card actually executed before the snapshot");

  const next = flow.reassignCard({ current: before.flow, station: stationB });
  assert.equal(next.ok, true, next.reason);

  // Simulate the caller's write, then re-read: the identity must be identical.
  const originalHistory = JSON.parse(JSON.stringify(before.history));
  const originalSession = before.sessionId;
  engine.setTaskFlow(created.id, next.flow);
  await engine.saveTasks();

  const after = engine.getRecord(created.id);
  assert.equal(after.id, created.id, "task id is the card's identity");
  assert.equal(after.sessionId, originalSession, "the bound session does not move");
  assert.deepEqual(after.history, originalHistory, "execution history does not move");
  assert.equal(after.flow.stationId, "review", "only the station changed");
  assert.equal(after.prompt, "draft the report", "the work itself does not change");
});

test("reassign: an unresolvable station is refused and nothing moves", () => {
  const current = flow.stampAcceptance({ flowId: "content" }, stationA);
  const refused = flow.reassignCard({
    current,
    station: stationB,
    resolve: () => ({ ok: false, reason: "persona 'reviewer' does not exist in this cell" }),
  });
  assert.equal(refused.ok, false);
  assert.ok(refused.reason.includes("does not exist"));
  // The card keeps its ORIGINAL attribution — a refusal that leaves the card in
  // neither station is worse than the refusal itself.
  assert.equal(current.stationId, "draft");
});

test("reassign: the previous station's verdict does not travel", () => {
  const judged = { ...flow.stampAcceptance({ flowId: "content" }, stationA), verdict: { outcome: "pass", at: 1 } };
  const next = flow.reassignCard({ current: judged, station: stationB });
  assert.equal(next.ok, true);
  assert.equal(next.flow.verdict, null, "a new station starts un-judged");
  assert.equal(next.flow.flowId, "content", "flow attribution survives");
  // ...and the new station's criteria replace the old ones.
  assert.deepEqual(next.flow.acceptance.map((a) => a.id), ["b1"]);
});

test("reassign: crossing into another flow is the same rewrite", () => {
  const current = flow.stampAcceptance({ flowId: "content" }, stationA);
  const next = flow.reassignCard({
    current: { ...current, flowId: "research" },
    station: stationB,
  });
  assert.equal(next.ok, true);
  assert.equal(next.flow.flowId, "research", "the flow label moves with the station");
  // Nothing about the task object is rebuilt — only this attribution dict.
  assert.ok(!("id" in next.flow), "the attribution carries no task identity of its own");
});

test("reassign: attribution survives a restart verbatim", async () => {
  await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });
  const t = engine.createManualTask({ prompt: "persisted-takeover", persona: "p1", flow: flow.stampAcceptance({ flowId: "content" }, stationA) });
  engine.setTaskFlow(t.id, flow.reassignCard({ current: engine.getRecord(t.id).flow, station: stationB }).flow);
  await engine.whenTasksPersisted();

  await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });
  const reloaded = engine.listTasks().find((x) => x.prompt === "persisted-takeover");
  assert.ok(reloaded, "the card survives the restart");
  assert.equal(reloaded.flow.stationId, "review");
});

// ── 4.2 trail ────────────────────────────────────────────────────────────────

test("trail: every reassignment is readable with before/after, actor and time", () => {
  const db = createTaskFlowDatabase({ file: path.join(tmpRoot, "trail.db") });
  db.recordReassignment({
    taskId: "task_1",
    from: { flowId: "content", stationId: "draft" },
    to: { flowId: "research", stationId: "review" },
    actor: "owner@example.com",
    reason: "换团队接管",
  });
  db.recordReassignment({
    taskId: "task_1",
    from: { flowId: "research", stationId: "review" },
    to: { flowId: "research", stationId: "publish" },
    actor: "owner@example.com",
  });

  const trail = db.reassignmentsOf("task_1");
  assert.equal(trail.length, 2, "both reassignments are readable");
  assert.deepEqual(trail[0].from, { flowId: "content", stationId: "draft" });
  assert.deepEqual(trail[0].to, { flowId: "research", stationId: "review" });
  assert.equal(trail[0].actor, "owner@example.com");
  assert.equal(trail[0].reason, "换团队接管");
  assert.ok(trail[0].at > 0, "the trail carries a timestamp");
  // Append-only: the two events read in order and neither rewrote the other.
  assert.equal(trail[1].from.stationId, "review");
});

test("trail: reassignments never enter the task's execution history", async () => {
  // history[] is EXECUTION history. history-kinds.js records the day a note
  // there turned a 38.3% failure rate into a reported 62.1% — a reassignment is
  // not an attempt, so it must not appear in that array at all.
  await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });
  const t = engine.createManualTask({ prompt: "no-history-pollution", persona: "p1", flow: flow.stampAcceptance({ flowId: "content" }, stationA) });
  const beforeLen = engine.getRecord(t.id).history.length;
  flow.reassignCard({ current: engine.getRecord(t.id).flow, station: stationB });
  assert.equal(engine.getRecord(t.id).history.length, beforeLen, "reassignment adds no execution entry");
});
