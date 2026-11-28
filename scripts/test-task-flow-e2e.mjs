#!/usr/bin/env node
// ── End-to-end: one card through the whole lifecycle (add-task-flow, task 8.1)
//
// 待安排 → 派单 → 执行 → 待签收 → 签收 → 已完成, then a mid-flight takeover
// into another flow with the session and history intact.
//
// This is the integration face: it drives the REAL routes and the REAL engine,
// so a passing run means the pieces agree, not that each piece passes alone.
//
//   node --test scripts/test-task-flow-e2e.mjs

import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "task-flow-e2e-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const engine = await import("../task-engine.js");
const { registerFlowRoutes } = await import("../server/routes/flows.js");
const { createTaskFlowDatabase } = await import("../server/task-flow-db.js");
const { columnOf } = await import("../web/src/lib/flow-board.ts");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));
const open = new Set();
test.afterEach(() => { for (const s of open) { try { s.close(); } catch { /* closed */ } } open.clear(); });

async function harness() {
  const turns = [];
  await engine.initTaskEngine({
    broadcast: () => {},
    isBusy: () => false,
    runTurn: async (t) => {
      turns.push(t.id);
      return { ok: true };
    },
  });
  const taskFlowDatabase = createTaskFlowDatabase({ file: path.join(tmpRoot, `e2e-${Math.random().toString(36).slice(2)}.db`) });
  const app = express();
  app.use(express.json());
  registerFlowRoutes(
    { app, taskFlowDatabase, authEnabled: false, flowExists: { persona: () => true, a2a: () => true, cluster: () => true, tool: () => true } },
    {},
  );
  const server = app.listen(0, "127.0.0.1");
  open.add(server);
  await new Promise((r) => server.once("listening", r));
  return { base: `http://127.0.0.1:${server.address().port}`, taskFlowDatabase, turns };
}

const call = async (base, method, url, body) => {
  const res = await fetch(`${base}${url}`, {
    method, headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const CONTENT = {
  flowId: "content",
  name: "内容生产",
  stations: [
    { stationId: "draft", label: "起草", target: { kind: "persona", ref: "writer" }, acceptance: [{ id: "has", kind: "artifact-exists", target: "draft.md" }] },
    { stationId: "publish", label: "发布", target: { kind: "persona", ref: "publisher" }, acceptance: [{ id: "ok", kind: "command-succeeds", target: "npm run publish" }] },
  ],
};

const RESEARCH = {
  flowId: "research",
  name: "研究工作",
  stations: [{ stationId: "review", label: "复核", target: { kind: "persona", ref: "reviewer" }, acceptance: [] }],
};

test("8.1 full lifecycle, then a takeover that keeps session and history", async () => {
  const h = await harness();
  await call(h.base, "PUT", "/api/flows/content", CONTENT);
  await call(h.base, "PUT", "/api/flows/research", RESEARCH);

  // 待安排
  const created = await call(h.base, "POST", "/api/flows/content/cards", { prompt: "写年度报告", stationId: "draft", title: "年度报告" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  let card = created.body.card;
  assert.equal(columnOf(card), "backlog", "creation lands in backlog, not running");

  // 派单 → 执行 → 待签收
  assert.equal((await call(h.base, "POST", `/api/flows/cards/${card.id}/dispatch`, {})).status, 200);
  for (let i = 0; i < 100; i += 1) {
    card = engine.getTask(card.id);
    if (card.state === "done") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(card.state, "done", "the turn actually ran");
  // THE assertion this whole change exists for:
  assert.equal(columnOf(card), "review", "executed is NOT done");

  // 签收 → 已完成
  const accepted = await call(h.base, "POST", `/api/flows/cards/${card.id}/accept`, { artifacts: [{ path: "draft.md", bytes: 2048 }] });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(columnOf(engine.getTask(card.id)), "done", "only the ruling reaches done");

  // 接管: same card, another flow's station. Identity must not move.
  const before = engine.getRecord(card.id);
  const sessionId = before.sessionId;
  const historyLen = before.history.length;
  assert.ok(historyLen > 0, "the card has real history by now");

  const moved = await call(h.base, "POST", `/api/flows/cards/${card.id}/reassign`, { flowId: "research", stationId: "review", reason: "换组复核" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));

  const after = engine.getRecord(card.id);
  assert.equal(after.id, card.id, "task id unchanged");
  assert.equal(after.sessionId, sessionId, "session unchanged");
  assert.equal(after.history.length, historyLen, "history unchanged");
  assert.equal(after.flow.flowId, "research");
  assert.equal(after.flow.stationId, "review");
  // The previous flow's passing verdict did NOT travel — a new station starts unruled.
  assert.equal(after.flow.verdict, null);
  assert.equal(columnOf(engine.getTask(card.id)), "review", "a takeover reopens the card for sign-off");

  // The trail survives the session.
  const trail = h.taskFlowDatabase.reassignmentsOf(card.id);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].from.flowId, "content");
  assert.equal(trail[0].to.flowId, "research");
  assert.equal(trail[0].reason, "换组复核");
});

test("8.2 rollback rehearsal: without the flow field, the engine behaves as before", async () => {
  // The rollback story must be true, not aspirational: a record with NO flow
  // attribution runs, persists and reloads exactly like a pre-change record.
  const turns = [];
  await engine.initTaskEngine({
    broadcast: () => {}, isBusy: () => false,
    runTurn: async (t) => { turns.push(t.id); return { ok: true }; },
  });
  const t = engine.createManualTask({ prompt: "no flow at all", persona: "p1" });
  for (let i = 0; i < 100 && turns.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(turns, [t.id], "a flow-less card still runs");

  await engine.whenTasksPersisted();
  await engine.initTaskEngine({ broadcast: () => {}, isBusy: () => false, runTurn: async () => ({ ok: true }) });
  const reloaded = engine.getRecord(t.id);
  assert.ok(reloaded, "survives the reload");
  assert.equal(reloaded.flow ?? null, null, "no flow attribution is the honest absence");
});
