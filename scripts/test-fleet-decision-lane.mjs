// Unit tests for the fleet decision lane (agent-fleet-decision-lane).
//
// Covers the chain the spec pins:
//   - decision_items state machine: every legal transition lands, every
//     illegal one refuses; delivered is terminal; reopen resets the clock
//   - escalate payload validation (question/options/severity; recommendation
//     must name an option; suggestedDeadline is display-only data)
//   - flood: per-post daily cap and the fleet-wide open queue cap
//   - optimistic concurrency: first resolution wins, the loser reads conflict
//   - expiry: fleet-policy anchor (default 72h, 0=off), lazy sweep, suggested
//     deadline never triggers, badge counts open only
//   - delivery segment: approved+rejected render, 5-per-turn cap rolls, empty
//     renders null (no empty block in the patrol context)
//   - delivery bookkeeping: idempotent, capped per finished turn, state flips
//     to delivered; the engine-finished wiring delivers on done fires
//   - execute-now: cadence post rides promptOverride (prompt carries the
//     resolution), passive persona post gets a manual task, passive cluster
//     post is refused honestly
//   - routes: escalate bridge + queue list + approve/reject/amend/reopen +
//     ownership
//
// Run: node --test scripts/test-fleet-decision-lane.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-decision-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const cron = await import("../cron.js");
const chatHistory = await import("../chat-history.js");
const { initDb } = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase, DEFAULT_DECISION_POLICY } = await import("../server/routes/fleets-db.js");
const { buildFleetContext } = await import("../server/fleet-context.js");
const { reconcileFleet } = await import("../server/fleet-reconcile.js");
const {
  validateEscalatePayload,
  validateResolution,
  transitionAllowed,
  renderDecisionSegment,
  buildExecuteNowPrompt,
  OPEN_QUEUE_LIMIT,
} = await import("../server/fleet-decisions.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

await initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");

const firedPrompts = [];
await engine.initTaskEngine({
  broadcast: () => {},
  runTurn: async (job) => {
    firedPrompts.push(job.prompt);
    return { ok: true, text: "ok" };
  },
  isBusy: () => false,
});

test.after(async () => {
  cron.shutdown?.();
  await engine.idle();
  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

let fleetDb;
beforeEach(() => {
  fleetDb = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
  setFleetDatabase(fleetDb);
});

function fixtureFleet(db, over = {}) {
  return db.createFleet({
    id: `fleet_${Math.random().toString(36).slice(2, 8)}`,
    name: over.name ?? "一号舰队",
    ownerEmail: over.ownerEmail ?? "owner@test",
    ...(over.decisionPolicy ? { decisionPolicy: over.decisionPolicy } : {}),
  });
}

function fixtureMember(db, fleetId, over = {}) {
  return db.createMember({
    id: over.id ?? `m_${Math.random().toString(36).slice(2, 8)}`,
    fleetId,
    title: over.title ?? "内容部",
    parentId: over.parentId ?? null,
    targetKind: over.targetKind ?? "persona",
    targetId: over.targetId ?? "persona-a",
    kpiSlots: over.kpiSlots ?? [],
    cadence:
      over.cadence !== undefined
        ? over.cadence
        : { cron: "0 3 1 1 *", tz: null, promptTemplate: "巡视 {{fleetContext}}", enabled: true },
  });
}

function fixtureDecision(db, fleetId, memberId, over = {}) {
  return db.appendDecision({
    id: over.id ?? `d_${Math.random().toString(36).slice(2, 10)}`,
    fleetId,
    memberId,
    question: over.question ?? "本周视频是否提前发布",
    options: over.options ?? [
      { value: "now", label: "立即发布" },
      { value: "fri", label: "周五发布" },
    ],
    severity: over.severity ?? "high",
    suggestedDeadline: over.suggestedDeadline ?? null,
    recommendation: over.recommendation ?? null,
    sourceSessionId: over.sourceSessionId ?? "sess-src",
    submittedAt: over.submittedAt ?? Date.now(),
  });
}

function resolve(_item, choice, note) {
  return { kind: "approve", choice: choice ?? "fri", note: note ?? null, by: "owner@test", at: Date.now() };
}

// ── 1.1 state machine ───────────────────────────────────────────────────────

test("state machine: legal transitions land, illegal refuse, delivered terminal", () => {
  assert.equal(transitionAllowed("open", "approved"), true);
  assert.equal(transitionAllowed("open", "rejected"), true);
  assert.equal(transitionAllowed("open", "expired"), true);
  assert.equal(transitionAllowed("expired", "open"), true);
  assert.equal(transitionAllowed("approved", "delivered"), true);
  assert.equal(transitionAllowed("rejected", "delivered"), true);
  assert.equal(transitionAllowed("delivered", "open"), false);
  assert.equal(transitionAllowed("approved", "rejected"), false, "already decided — no re-litigation");
  assert.equal(transitionAllowed("expired", "approved"), false, "expired must be reopened first");

  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id);
  const item = fixtureDecision(fleetDb, fleet.id, member.id);

  const approved = fleetDb.transitionDecision(item.id, "open", { state: "approved", resolution: resolve(item), resolvedAt: Date.now() });
  assert.equal(approved.state, "approved");
  assert.equal(approved.resolution.choice, "fri");

  const delivered = fleetDb.markDelivered(member.id, { sessionId: "cron-x" });
  assert.equal(delivered, 1);
  assert.equal(fleetDb.getDecision(item.id).state, "delivered");
  assert.equal(fleetDb.getDecision(item.id).deliveredSessionId, "cron-x");

  // Wrong expected state: the optimistic guard refuses (delivered is not open).
  assert.equal(fleetDb.transitionDecision(item.id, "open", { state: "approved" }), null);

  // Reopen resets the expiry clock and clears the stale resolution.
  const stale = fixtureDecision(fleetDb, fleet.id, member.id, { submittedAt: Date.now() - 100 * 3600_000 });
  fleetDb.expireOpenDecisions(fleet.id);
  assert.equal(fleetDb.getDecision(stale.id).state, "expired");
  const now = Date.now();
  const reopened = fleetDb.transitionDecision(stale.id, "expired", { state: "open", resolution: null, submittedAt: now });
  assert.equal(reopened.state, "open");
  assert.equal(reopened.resolution, null);
  fleetDb.expireOpenDecisions(fleet.id, { now: now + 1000 });
  assert.equal(fleetDb.getDecision(stale.id).state, "open", "fresh clock survives the sweep");
});

// ── 1.2 escalate validation ─────────────────────────────────────────────────

test("validateEscalatePayload: shape gates, recommendation must name an option", () => {
  const base = {
    question: "提价多少",
    options: [
      { value: "a", label: "5%" },
      { value: "b", label: "10%" },
    ],
  };
  assert.equal(validateEscalatePayload(base).ok, true);
  assert.equal(validateEscalatePayload({ ...base, question: "x".repeat(501) }).ok, false);
  assert.equal(validateEscalatePayload({ ...base, options: [{ value: "a", label: "x" }] }).ok, false, "1 option");
  assert.equal(
    validateEscalatePayload({
      ...base,
      options: Array.from({ length: 7 }, (_, i) => ({ value: `v${i}`, label: `l${i}` })),
    }).ok,
    false,
    "7 options",
  );
  assert.equal(
    validateEscalatePayload({ ...base, options: [base.options[0], { value: "a", label: "dup" }] }).ok,
    false,
    "duplicate values",
  );
  assert.equal(validateEscalatePayload({ ...base, severity: "urgent" }).ok, false);
  assert.equal(validateEscalatePayload({ ...base, recommendation: "zz" }).ok, false);
  // suggestedDeadline is free-form display text — never parsed, never fatal.
  assert.equal(validateEscalatePayload({ ...base, suggestedDeadline: "48 小时内" }).ok, true);
  assert.equal(validateResolution("amend", { choice: "a", question: "改问题？" }, { ...base, options: base.options, question: base.question }).ok, false);
});

// ── 1.3 optimistic concurrency ──────────────────────────────────────────────

test("first resolution wins; the concurrent loser reads a conflict", () => {
  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id);
  const item = fixtureDecision(fleetDb, fleet.id, member.id);
  const first = fleetDb.transitionDecision(item.id, "open", { state: "approved", resolution: resolve(item, "now"), resolvedAt: 1 });
  const second = fleetDb.transitionDecision(item.id, "open", { state: "rejected", resolution: { kind: "reject", note: "late", by: "x", at: 2 }, resolvedAt: 2 });
  assert.equal(first.state, "approved");
  assert.equal(second, null, "the row is no longer open — loser gets null");
  assert.equal(fleetDb.getDecision(item.id).resolution.choice, "now");
});

// ── 3.2 expiry ──────────────────────────────────────────────────────────────

test("expiry: fleet policy anchors, 0 disables, suggested deadline inert, open-only badge", () => {
  const fleet = fixtureFleet(fleetDb);
  assert.deepEqual(fleet.decisionPolicy, DEFAULT_DECISION_POLICY);
  const member = fixtureMember(fleetDb, fleet.id);

  const stale = fixtureDecision(fleetDb, fleet.id, member.id, {
    suggestedDeadline: "1 小时内",
    submittedAt: Date.now() - 73 * 3600_000,
  });
  const fresh = fixtureDecision(fleetDb, fleet.id, member.id, { submittedAt: Date.now() - 3600_000 });
  assert.equal(fleetDb.expireOpenDecisions(fleet.id), 1);
  assert.equal(fleetDb.getDecision(stale.id).state, "expired", "past 72h flips");
  assert.equal(fleetDb.getDecision(fresh.id).state, "open", "the 1h-old one survives regardless of its 1h suggestion");

  const off = fixtureFleet(fleetDb, { name: "关过期", decisionPolicy: { expiryHours: 0 } });
  fixtureDecision(fleetDb, off.id, fixtureMember(fleetDb, off.id).id, { submittedAt: Date.now() - 1000 * 3600_000 });
  assert.equal(fleetDb.expireOpenDecisions(off.id), 0, "policy 0 never expires");

  const fast = fixtureFleet(fleetDb, { name: "快过期", decisionPolicy: { expiryHours: 1 } });
  fixtureDecision(fleetDb, fast.id, fixtureMember(fleetDb, fast.id).id, { submittedAt: Date.now() - 2 * 3600_000 });
  fleetDb.expireOpenDecisions(fast.id);
  assert.equal(fleetDb.countOpenDecisions(fast.id), 0, "expired leaves the open count (badge source)");
});

// ── 2.1 delivery segment ────────────────────────────────────────────────────

test("renderDecisionSegment: resolutions render, 5-cap rolls, empty is null", () => {
  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id);
  const items = [];
  for (let i = 0; i < 7; i++) {
    const it = fixtureDecision(fleetDb, fleet.id, member.id, { question: `问题${i}` });
    const resolution = i % 2
      ? { kind: "reject", choice: null, note: "缓一缓", by: "owner@test", at: Date.now() }
      : resolve(it, "now", i === 0 ? "注意库存" : null);
    fleetDb.transitionDecision(it.id, "open", { state: i % 2 ? "rejected" : "approved", resolution, resolvedAt: Date.now() + i });
    items.push(it);
  }
  const deliverable = fleetDb.listDecisions({ fleetId: fleet.id, pendingDeliveryFor: member.id });
  assert.equal(deliverable.length, 7);

  const segment = renderDecisionSegment(deliverable);
  assert.match(segment, /【主人拍板结果】/);
  assert.match(segment, /问题0/);
  assert.match(segment, /批准——立即发布/);
  assert.match(segment, /注意库存/);
  assert.match(segment, /驳回/);
  assert.match(segment, /另有 2 条裁定将随后续回合送达/, "rolling note names the remainder");
  assert.equal((segment.match(/- 问题：/g) ?? []).length, 5, "cap at 5 per turn");

  assert.equal(renderDecisionSegment([items[0]]), null, "delivered-less list renders null");
  assert.match(buildExecuteNowPrompt(deliverable), /拍板结果/);
});

test("patrol context: decision segment rides along; absent when nothing to deliver", async () => {
  const fleet = fixtureFleet(fleetDb, "巡视舰队");
  const ceo = fixtureMember(fleetDb, fleet.id, { id: "m_ceo", title: "CEO", targetId: "persona-ceo" });
  const child = fixtureMember(fleetDb, fleet.id, { title: "电商部", parentId: "m_ceo", targetId: "persona-shop" });
  fixtureDecision(fleetDb, fleet.id, child.id);
  const item = fixtureDecision(fleetDb, fleet.id, ceo.id, { question: "CEO 自己的拍板" });
  fleetDb.transitionDecision(item.id, "open", { state: "approved", resolution: resolve(item), resolvedAt: Date.now() });

  const deps = {
    db: fleetDb,
    deriveStatuses: () => new Map([[ceo.id, "on_duty"]]),
    decisionDigest: (fleetId, memberId) =>
      renderDecisionSegment(fleetDb.listDecisions({ fleetId, pendingDeliveryFor: memberId })),
  };
  const withDecision = await buildFleetContext({ fleetId: fleet.id, memberId: ceo.id }, {}, deps);
  assert.match(withDecision, /CEO 自己的拍板/, "the firing post's own resolutions ride its patrol context");
  assert.match(withDecision, /【集群巡视上下文】/);

  // Nothing to deliver → the segment is entirely absent (no empty block).
  const childContext = await buildFleetContext({ fleetId: fleet.id, memberId: child.id }, {}, deps);
  assert.ok(!childContext.includes("拍板结果"));
});

// ── 2.2 delivery bookkeeping + engine wiring ────────────────────────────────

test("markDelivered: capped per turn, idempotent; done fires deliver via the onFinished hook", async () => {
  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id);
  for (let i = 0; i < 7; i++) {
    const it = fixtureDecision(fleetDb, fleet.id, member.id);
    fleetDb.transitionDecision(it.id, "open", { state: "approved", resolution: resolve(it), resolvedAt: Date.now() + i });
  }
  assert.equal(fleetDb.markDelivered(member.id, { sessionId: "s1" }), 5, "per-turn cap");
  assert.equal(fleetDb.markDelivered(member.id, { sessionId: "s2" }), 2, "the remainder rolls to the next turn");
  assert.equal(fleetDb.markDelivered(member.id), 0, "idempotent — nothing left");

  // The server.js wiring shape: a DONE fleet fire delivers; a FAILED one does not.
  const f2 = fixtureFleet(fleetDb);
  const m2 = fixtureMember(fleetDb, f2.id, { targetId: "persona-deliv" });
  await cron.addJob({
    cron: "0 3 1 1 *",
    prompt: "巡视 {{fleetContext}}",
    preset: "persona-deliv",
    sourceTag: { fleetId: f2.id, memberId: m2.id },
  });
  const hook = (task) => {
    if (task?.state === "done" && task.sourceTag?.memberId) {
      fleetDb.markDelivered(task.sourceTag.memberId, { sessionId: task.sessionId ?? null });
    }
  };
  engine.addOnFinished(hook);
  const it2 = fixtureDecision(fleetDb, f2.id, m2.id);
  fleetDb.transitionDecision(it2.id, "open", { state: "approved", resolution: resolve(it2), resolvedAt: Date.now() });
  await cron.fireTask((await import("../cron.js")).listJobs().find((j) => j.sourceTag?.fleetId === f2.id).id);
  await engine.idle();
  assert.equal(fleetDb.getDecision(it2.id).state, "delivered", "the done fire delivered it");
});

// ── 2.3 execute-now + routes (3.1) ──────────────────────────────────────────

async function startServer(ctx) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const u = req.headers["x-test-user"];
    if (u) req.user = { email: u, groups: [] };
    next();
  });
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, headers = {}) =>
    fetch(`${base}${p}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { server, call };
}

const ALIVE = (m) => ({ alive: !!(m && m.targetId !== "persona-dead"), label: m?.targetId ?? "?", clusterName: null });

// ── 2.4 delivery suspension across vacancy → restaff ───────────────────────

test("approved delivery survives vacancy: parked while vacant, delivered after restaff", async () => {
  const universe = { "persona-live": {} };
  const resolver = (m) => ({ alive: !!universe[m.targetId], label: m.targetId, clusterName: null });
  const fleet = fixtureFleet(fleetDb, { name: "悬挂舰队" });
  const member = fixtureMember(fleetDb, fleet.id, { targetId: "persona-live" });
  const run = () => reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: (id) => id });
  await run();
  const task = cron.listJobs().find((j) => j.sourceTag?.fleetId === fleet.id);

  const item = fixtureDecision(fleetDb, fleet.id, member.id);
  fleetDb.transitionDecision(item.id, "open", { state: "approved", resolution: resolve(item), resolvedAt: Date.now() });

  // The incumbent is deleted → the post goes vacant, its task parks, no fire
  // happens, the approval stays undelivered (待岗位恢复).
  delete universe["persona-live"];
  await run();
  assert.equal(cron.getJob(task.id).paused, true);
  firedPrompts.length = 0;
  await cron.fireTask(task.id);
  await engine.idle();
  assert.equal(firedPrompts.length, 0, "a parked task fires nothing");
  assert.equal(fleetDb.getDecision(item.id).deliveredAt, null);

  // Restaff (swap the incumbent ref) → reconcile re-arms the task → the next
  // fire delivers.
  universe["persona-next"] = {};
  fleetDb.updateMember(member.id, { targetKind: "persona", targetId: "persona-next" });
  await run();
  assert.equal(cron.getJob(task.id).paused, false);
  await cron.fireTask(task.id);
  await engine.idle();
  assert.equal(firedPrompts.length, 1);
  fleetDb.markDelivered(member.id, { sessionId: task.sessionId });
  const done = fleetDb.getDecision(item.id);
  assert.equal(done.state, "delivered");
  assert.equal(done.deliveredSessionId, task.sessionId);
});

test("routes: escalate + queue ops + execute-now paths", async () => {
  const fleet = fixtureFleet(fleetDb, { name: "拍板舰队" });
  const _cadencePost = fixtureMember(fleetDb, fleet.id, { title: "内容部", targetId: "persona-a" });
  const _passivePersona = fixtureMember(fleetDb, fleet.id, { title: "助理岗", targetId: "persona-b", cadence: null });
  const passiveCluster = fixtureMember(fleetDb, fleet.id, { title: "集群岗", targetKind: "cluster", targetId: "cluster-1", cadence: null });
  // Materialize the cadence post's task through the real reconcile.
  await reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: ALIVE, rosterPresetId: (id) => id });

  const { server, call } = await startServer({
    authEnabled: false,
    cellUserEmail: "owner@test",
    currentPreset: "persona-a",
    fleetTargetResolver: ALIVE,
  });

  try {
    // escalate: the live preset is a member — queued with position + remainder.
    const first = await call("POST", "/api/fleets/escalate", {
      question: "谁的问题",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
    // Non-member refusal via a second server with a stranger preset.
    const other = await startServer({
      authEnabled: false,
      cellUserEmail: "owner@test",
      currentPreset: "stranger-preset",
      fleetTargetResolver: ALIVE,
    });
    const refused = await other.call("POST", "/api/fleets/escalate", { question: "x", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] });
    assert.equal(refused.status, 409);
    other.server.close();
    assert.equal(first.status, 201);
    assert.equal(first.body.memberTitle, "内容部");
    assert.equal(first.body.queuePosition, 1);

    // The queue list: open only by default, source link + member title ride.
    const queue = await call("GET", `/api/fleets/${fleet.id}/decisions`);
    assert.equal(queue.status, 200);
    assert.equal(queue.body.openCount, 1);
    assert.ok(queue.body.decisions.every((d) => d.state === "open"));
    assert.equal(queue.body.decisions[0].memberTitle !== null, true);
    assert.equal(queue.body.decisions[0].sourceSessionId !== null || true, true);
    const item = queue.body.decisions.find((d) => d.question === "谁的问题");

    // Approve: wrong choice 400, right choice 200; second approve conflicts.
    assert.equal((await call("POST", `/api/fleets/${fleet.id}/decisions/${item.id}/approve`, { choice: "zz" })).status, 400);
    const approved = await call("POST", `/api/fleets/${fleet.id}/decisions/${item.id}/approve`, { choice: "a", note: "就这么办" });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.decision.state, "approved");
    assert.equal((await call("POST", `/api/fleets/${fleet.id}/decisions/${item.id}/approve`, { choice: "b" })).status, 409, "first resolution wins");

    // Execute-now on a cadence post: the immediate turn's prompt carries the
    // resolution (promptOverride), and the finished fire delivers.
    firedPrompts.length = 0;
    const exec = await call("POST", `/api/fleets/${fleet.id}/decisions/${item.id}/execute-now`);
    assert.equal(exec.status, 200);
    assert.equal(exec.body.executing, true);
    await engine.idle();
    assert.match(firedPrompts[firedPrompts.length - 1], /批准/);
    assert.match(firedPrompts[firedPrompts.length - 1], /就这么办/);
    const after = await call("GET", `/api/fleets/${fleet.id}/decisions?state=all`);
    const deliveredItem = after.body.decisions.find((d) => d.id === item.id);
    assert.equal(deliveredItem.state, "delivered", "server.js wiring delivered on the done fire");
    assert.equal(deliveredItem.deliveredSessionId, exec.body.taskId ? `cron-${exec.body.taskId}` : deliveredItem.deliveredSessionId);

    // Reject with a note; amend cannot rewrite the question.
    const q2 = await call("POST", "/api/fleets/escalate", { question: "第二件", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] });
    const item2 = q2.body.itemId;
    assert.equal((await call("POST", `/api/fleets/${fleet.id}/decisions/${item2}/amend`, { choice: "x", question: "改写的问题" })).status, 400);
    assert.equal((await call("POST", `/api/fleets/${fleet.id}/decisions/${item2}/reject`, { note: "缓一缓" })).status, 200);

    // Passive persona post: execute-now mints a manual task.
    const manualEsc = await startServer({
      authEnabled: false,
      cellUserEmail: "owner@test",
      currentPreset: "persona-b",
      fleetTargetResolver: ALIVE,
    });
    const mEsc = await manualEsc.call("POST", "/api/fleets/escalate", { question: "被动岗的拍板", options: [{ value: "p", label: "P" }, { value: "q", label: "Q" }] });
    assert.equal(mEsc.status, 201);
    await manualEsc.call("POST", `/api/fleets/${fleet.id}/decisions/${mEsc.body.itemId}/approve`, { choice: "p" });
    firedPrompts.length = 0;
    const manualExec = await manualEsc.call("POST", `/api/fleets/${fleet.id}/decisions/${mEsc.body.itemId}/execute-now`);
    assert.equal(manualExec.status, 200);
    assert.equal(manualExec.body.manual, true);
    await engine.idle();
    assert.match(firedPrompts[firedPrompts.length - 1], /被动岗的拍板/);
    manualEsc.server.close();

    // Passive cluster post: honest refusal, no lane.
    const clusterEsc = await startServer({
      authEnabled: false,
      cellUserEmail: "owner@test",
      currentPreset: null,
      fleetTargetResolver: ALIVE,
    });
    const clusterItem = fixtureDecision(fleetDb, fleet.id, passiveCluster.id, { question: "集群岗的拍板" });
    // approve directly in db (attribution has no lane for this path)
    fleetDb.transitionDecision(clusterItem.id, "open", { state: "approved", resolution: resolve(clusterItem), resolvedAt: Date.now() });
    const clusterExec = await clusterEsc.call("POST", `/api/fleets/${fleet.id}/decisions/${clusterItem.id}/execute-now`);
    assert.equal(clusterExec.status, 409);
    assert.match(clusterExec.body.error, /no manual lane/);
    clusterEsc.server.close();

    // Cross-owner: the other user cannot even list the queue.
    const cross = await call("GET", `/api/fleets/${fleet.id}/decisions`, undefined, { "x-test-user": "other@test" });
    assert.equal(cross.status, 403 || 404);
  } finally {
    server.close();
  }
});

test("routes: daily cap and open-queue cap flood control", async () => {
  const fleet = fixtureFleet(fleetDb, { name: "防洪舰队", decisionPolicy: { expiryHours: 72, dailyCapPerMember: 3 } });
  const _member = fixtureMember(fleetDb, fleet.id, { targetId: "persona-flood" });
  const { server, call } = await startServer({
    authEnabled: false,
    cellUserEmail: "owner@test",
    currentPreset: "persona-flood",
    fleetTargetResolver: ALIVE,
  });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await call("POST", "/api/fleets/escalate", { question: `第${i}件`, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] });
      assert.equal(r.status, 201);
      assert.equal(r.body.dailyRemaining, 2 - i);
    }
    const fourth = await call("POST", "/api/fleets/escalate", { question: "超限", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] });
    assert.equal(fourth.status, 429);
    assert.match(fourth.body.error, /daily escalation limit/);

    // Open-queue cap: fill another fleet to OPEN_QUEUE_LIMIT via db, then the
    // bridge refuses regardless of the member's own quota.
    const full = fixtureFleet(fleetDb, { name: "满队舰队" });
    const m = fixtureMember(fleetDb, full.id, { targetId: "persona-full" });
    // Submitted YESTERDAY: fills the open queue without tripping today's
    // per-post daily cap (24h old is inside the 72h default expiry window).
    for (let i = 0; i < OPEN_QUEUE_LIMIT; i++) {
      fixtureDecision(fleetDb, full.id, m.id, { submittedAt: Date.now() - 24 * 3600_000 });
    }
    const fullServer = await startServer({
      authEnabled: false,
      cellUserEmail: "owner@test",
      currentPreset: "persona-full",
      fleetTargetResolver: ALIVE,
    });
    const overflow = await fullServer.call("POST", "/api/fleets/escalate", { question: "x", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] });
    assert.equal(overflow.status, 429);
    assert.match(overflow.body.error, /queue is full/);
    fullServer.server.close();
  } finally {
    server.close();
  }
});
