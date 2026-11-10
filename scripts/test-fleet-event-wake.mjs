// Unit tests for fleet event wake (add-fleet-event-wake).
//
// Covers the spec pins:
//   - a declared bot:<id> event edge turns an inbound message into the bound
//     post's manual turn: prompt carries sender + text verbatim, origin has
//     BOTH the fleet attribution segment (memberId, depth 0) and the event
//     segment (botId, chatKey)
//   - the turn contract derives source=event / depth=0 from origin.event
//     (and event is a legal source now — only peer stays reserved)
//   - edge validation: persona/a2a targets pass, cluster/tool targets and
//     non-bot: from shapes are refused
//   - no matching edge ⇒ zero disturbance (no tasks, no events)
//   - the hourly cap: over-limit messages create no task but leave an honest
//     O1 event row
//
// Run: node --test scripts/test-fleet-event-wake.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "event-wake-"));
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
const { triggerFleetEventWake } = await import("../server/fleet-event-wake.js");
const { buildTurnRequest, assertTurnRequest, SOURCES, RESERVED_SOURCES } = await import("../server/turn-request.js");
const { validateOrchestration } = await import("../server/fleet-orchestration.js");

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

// This suite pins the WAKE SHAPE (origin segments, the hourly-cap refusal row)
// on the one-message-one-wake contract; the coalescing window is a separate
// layer with its own suite. Opt out explicitly rather than depend on timing.
process.env.EVENT_WAKE_COALESCE_MS = "0";

const deps = { engine, roster: (id) => `roster:${id}` };

test("wake: declared edge creates the post's turn with both origin segments", () => {
  const fleet = fleetDb.createFleet({ id: "f_ev", name: "客服舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "m_cs", fleetId: fleet.id, title: "客服岗", targetKind: "persona", targetId: "p-cs", kpiSlots: [], cadence: null });
  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [{ kind: "event", from: "bot:helper", to: "m_cs" }] } });

  const created = triggerFleetEventWake({ db: fleetDb, ...deps }, "helper", { chatKey: "tg:123", senderName: "张三", text: "我的订单在哪?" });
  assert.equal(created.length, 1);
  const task = engine.getTaskRecord(created[0].taskId);
  assert.equal(task.preset, "roster:p-cs");
  assert.ok(task.prompt.includes("张三"));
  assert.ok(task.prompt.includes("我的订单在哪?"));
  assert.deepEqual(task.origin.fleet, { fleetId: "f_ev", memberId: "m_cs", depth: 0 });
  assert.deepEqual(task.origin.event, { botId: "helper", chatKey: "tg:123" });

  // the contract reads it as an event wake
  const request = buildTurnRequest(task);
  assert.equal(request.source, "event");
  assert.equal(request.depth, 0);
  assert.equal(request.chain, null, "an event wake is a ROOT turn — it opens its own run (agent-fleet-runs)");
  assert.equal(assertTurnRequest(request), null, "event is a legal source now");
  assert.ok(SOURCES.includes("event"));
  assert.deepEqual(Object.keys(RESERVED_SOURCES), ["peer"], "only peer stays reserved");
});

test("wake: no matching edge (or archived fleet) ⇒ zero disturbance", () => {
  const fleet = fleetDb.createFleet({ id: "f_q", name: "静默舰", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "m_q", fleetId: fleet.id, title: "岗", targetKind: "persona", targetId: "p-q", kpiSlots: [], cadence: null });
  fleetDb.updateFleet(fleet.id, { orchestration: { edges: [{ kind: "event", from: "bot:other", to: "m_q" }] } });
  assert.deepEqual(triggerFleetEventWake({ db: fleetDb, ...deps }, "helper", { chatKey: "c", text: "hi" }), []);
  // archived fleets never wake
  fleetDb.updateFleet(fleet.id, { state: "archived" });
  assert.deepEqual(triggerFleetEventWake({ db: fleetDb, ...deps }, "other", { chatKey: "c", text: "hi" }), []);
});

test("wake: hourly cap leaves an honest event row and creates no task", () => {
  const prev = process.env.FLEET_EVENT_WAKE_HOURLY_CAP;
  process.env.FLEET_EVENT_WAKE_HOURLY_CAP = "2";
  try {
    const fleet = fleetDb.createFleet({ id: "f_cap", name: "护栏舰", ownerEmail: "owner@test" });
    fleetDb.createMember({ id: "m_cap", fleetId: fleet.id, title: "岗", targetKind: "persona", targetId: "p-cap", kpiSlots: [], cadence: null });
    fleetDb.updateFleet(fleet.id, { orchestration: { edges: [{ kind: "event", from: "bot:busy", to: "m_cap" }] } });
    assert.equal(triggerFleetEventWake({ db: fleetDb, ...deps }, "busy", { chatKey: "c", text: "1" }).length, 1);
    assert.equal(triggerFleetEventWake({ db: fleetDb, ...deps }, "busy", { chatKey: "c", text: "2" }).length, 1);
    const over = triggerFleetEventWake({ db: fleetDb, ...deps }, "busy", { chatKey: "c", text: "3" });
    assert.equal(over.length, 0, "over the cap: no task");
    const rows = fleetDb.listFleetTurnEvents("f_cap", { status: "failed" });
    assert.ok(rows.some((r) => r.error.includes("hourly cap") && r.source === "event"), "honest refusal row with source=event");
  } finally {
    if (prev === undefined) delete process.env.FLEET_EVENT_WAKE_HOURLY_CAP;
    else process.env.FLEET_EVENT_WAKE_HOURLY_CAP = prev;
  }
});

test("edge validation: event targets and from shape", () => {
  const members = [
    { id: "v_p", title: "p", targetKind: "persona" },
    { id: "v_a", title: "a", targetKind: "a2a" },
    { id: "v_c", title: "c", targetKind: "cluster" },
    { id: "v_t", title: "t", targetKind: "tool" },
  ];
  const ev = (over = {}) => validateOrchestration({ members, orchestration: { edges: [{ kind: "event", from: "bot:x", to: "v_p", ...over }] } });
  assert.equal(ev().ok, true);
  assert.equal(ev({ to: "v_a" }).ok, true);
  assert.equal(ev({ to: "v_c" }).ok, false, "cluster target refused");
  assert.equal(ev({ to: "v_t" }).ok, false, "tool target refused");
  assert.equal(ev({ from: "not-a-bot" }).ok, false, "from must be bot:<id>");
  assert.equal(ev({ from: "tg:group" }).ok, false, "colon-only shapes refused");
});
