// Unit tests — fleet-ops-canvas.
//
// Pins:
//   - recentResults ring: TTL prune, cardinality prune, failed entries keep
//     their outcome through the decay window
//   - memberView.latestTurnUsage: newest REAL turn's usage rides the view;
//     skip-only newest rounds don't null it (usage reads the real turn always)
//   - memberView bot sidecar: type/enabled from the bot row, chat/relay
//     timestamps as best-effort columns, honest nulls when nothing arrived
// Run: node --test scripts/test-fleet-ops-canvas.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ops-canvas-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const dbModule = await import("../db.js");
const { initDb } = dbModule;
await initDb();

const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { pruneResults, recordResult } = await import("../web/src/lib/fleet-recent-results.ts");

// ── recentResults ring ───────────────────────────────────────────────────────

const entry = (id, endedAt, extra = {}) => ({
  turnId: `t${id}`,
  fleetId: "f1",
  memberId: "m2",
  parentMemberId: "m1",
  edgeKind: "dispatch",
  status: "ok",
  errorKind: null,
  endedAt,
  ...extra,
});

test("ring: TTL prunes outcomes older than the window, keeps fresh failed", () => {
  const now = 1_000_000;
  const fresh = entry(1, now - 2_000, { status: "failed", errorKind: "timeout" });
  const stale = entry(2, now - 90_000);
  const out = recordResult(recordResult({}, fresh), stale);
  const pruned = pruneResults(out, now);
  assert.deepEqual(Object.keys(pruned), ["t1"]);
  assert.equal(pruned.t1.status, "failed");
  assert.equal(pruned.t1.errorKind, "timeout");
});

test("ring: cardinality prunes to the newest 40", () => {
  const now = 1_000_000;
  let map = {};
  for (let i = 0; i < 45; i++) map = recordResult(map, entry(i, now - i));
  assert.equal(Object.keys(map).length, 40);
  assert.equal(map["t0"].endedAt, now);
  assert.equal(map["t44"], undefined);
});

test("ring: non-numeric endedAt entry drops immediately", () => {
  const now = 1_000_000;
  const out = pruneResults({ t9: entry(9, Number.NaN), t1: entry(1, now - 100) }, now);
  assert.deepEqual(Object.keys(out), ["t1"]);
});

// ── memberView projections ───────────────────────────────────────────────────

function fixtureFleet(db, over = {}) {
  return db.createFleet({
    id: over.id ?? `fleet_${Math.random().toString(36).slice(2, 8)}`,
    name: over.name ?? "ops test fleet",
    ownerEmail: "owner@test",
    orchestration: over.orchestration ?? { mode: "pipeline", edges: [{ kind: "dispatch", from: "m1", to: "m2" }] },
  });
}

function fixtureMember(db, fleetId, over = {}) {
  return db.createMember({
    id: over.id ?? `m_${Math.random().toString(36).slice(2, 8)}`,
    fleetId,
    title: over.title ?? "post",
    parentId: over.parentId ?? null,
    targetKind: over.targetKind ?? "persona",
    targetId: over.targetId ?? "persona-a",
    kpiSlots: over.kpiSlots ?? [],
    cadence: over.cadence === undefined ? { cron: "0 * * * *", tz: null, promptTemplate: "报数", enabled: true } : over.cadence,
  });
}

let fleetDb;
beforeEach(async () => {
  fleetDb = createFleetDatabase({ file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`) });
  setFleetDatabase(fleetDb);
});

async function cockpitView(fleet, ctx = {}) {
  const { createFleetRoutes } = await import("../server/routes/fleets.js");
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, {
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: (member) => ({ alive: true, label: member.targetId }),
    ...ctx,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/fleets/${fleet.id}/cockpit`);
    const body = await res.json();
    if (!res.ok) throw new Error(`cockpit ${res.status}: ${JSON.stringify(body)}`);
    return body;
  } finally {
    server.close();
  }
}

function fixtureTurn(db, member, over = {}) {
  return db.appendTurnEvent({
    fleetId: member.fleetId,
    memberId: member.id,
    source: over.source ?? "cron",
    status: over.status ?? "ok",
    errorKind: over.errorKind ?? null,
    error: over.error ?? null,
    model: over.model ?? null,
    usage: over.usage ?? null,
    startedAt: over.startedAt ?? Date.now() - 60_000,
    endedAt: over.endedAt ?? Date.now(),
    sessionId: over.sessionId ?? null,
    traceTurnId: over.traceTurnId ?? null,
  });
}

test("latestTurnUsage: newest REAL turn's usage rides the member view", async () => {
  const fleet = fixtureFleet(fleetDb);
  fixtureMember(fleetDb, fleet.id, { id: "m1" });
  const m2 = fixtureMember(fleetDb, fleet.id, { id: "m2", contextBudget: 50_000 });
  // ok real turn with usage, then a skipped round on top — usage reads the
  // real one, the skip never zeroes the histogram.
  fixtureTurn(fleetDb, m2, { usage: { input: 12_000, output: 3_000 } });
  fixtureTurn(fleetDb, m2, { status: "skipped", startedAt: Date.now() - 500, endedAt: Date.now() - 100 });

  const cock = await cockpitView(fleet);
  const view = cock.members.find((x) => x.id === "m2");
  assert.deepEqual(view.latestTurnUsage, { input: 12_000, output: 3_000 });
  const plain = cock.members.find((x) => x.id === "m1");
  assert.equal(plain.latestTurnUsage, null);
});

test("member turns endpoint exposes traceTurnId — the mini span's second hop", async () => {
  const fleet = fixtureFleet(fleetDb);
  const m = fixtureMember(fleetDb, fleet.id, { id: "m-trace" });
  fixtureTurn(fleetDb, m, { traceTurnId: "turn_abc123" });
  const { createFleetRoutes } = await import("../server/routes/fleets.js");
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, { authEnabled: false, cellUserEmail: "owner@test", fleetTargetResolver: (x) => ({ alive: true, label: x.targetId }) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = await (await fetch(`${base}/api/fleets/${fleet.id}/members/m-trace/turns?limit=5`)).json();
    assert.equal(body.turns[0].traceTurnId, "turn_abc123");
  } finally {
    server.close();
  }
});

test("bot sidecar: type/enabled + honest nulls; inbound/relay rides when seen", async () => {
  const fleet = fixtureFleet(fleetDb);
  // Fresh bot with zero activity → nulls, enabled from the row.
  const bot = dbModule.addBot({ id: "bot-cockpit", type: "feishu", name: "客服号", credentials: { appId: "x" }, secret: "s", enabled: true });
  assert.ok(bot);
  fixtureMember(fleetDb, fleet.id, { id: "m1" });
  fixtureMember(fleetDb, fleet.id, { id: "m_bot", targetKind: "bot", targetId: "bot-cockpit" });

  let cock = await cockpitView(fleet);
  let view = cock.members.find((x) => x.id === "m_bot");
  assert.equal(view.bot.type, "feishu");
  assert.equal(view.bot.enabled, true);
  assert.equal(view.bot.lastInboundAt, null);
  assert.equal(view.bot.lastError, null);

  dbModule.upsertBotChat("bot-cockpit", "chat-1", "张三");
  dbModule.insertRelayLog({ channel: "default", botId: "bot-cockpit", textChars: 12, outcome: "failed", error: "502 from channel" });

  cock = await cockpitView(fleet);
  view = cock.members.find((x) => x.id === "m_bot");
  assert.ok(view.bot.lastInboundAt);
  assert.equal(view.bot.lastError, "502 from channel");
  // persona members carry no bot field at all.
  assert.equal(cock.members.find((x) => x.id === "m1").bot, undefined);
});
