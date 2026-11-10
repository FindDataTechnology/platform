// TRUE end-to-end for the event wake (add-fleet-event-wake): a platform-shaped
// inbound message over the REAL webhook HTTP route drives the full chain —
// webhook → verify → parse → guards → triggerFleetEventWake (real module) →
// engine manual task (origin.event) → runCronJobTurn seam → O1 event row with
// source=event. Real modules all the way; only the external Feishu server and
// the LLM are stubbed (dummy credentials / stub persona turn).
//
// Run: node --test scripts/test-bots-event-wake.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bots-event-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const db = await import("../db.js");
const chatHistory = await import("../chat-history.js");
const bots = await import("../server/bots.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotRoutes, WEBHOOK_PREFIX } = await import("../server/routes/bots.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const engine = await import("../task-engine.js");
const { triggerFleetEventWake } = await import("../server/fleet-event-wake.js");
const { recordTurnEvent } = await import("../server/fleet-events.js");
const { buildTurnRequest } = await import("../server/turn-request.js");
const { attachCronRunner } = await import("../server/cron-runner.js");

let server, base, ctx;
const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
setFleetDatabase(fleetDb);

// The turn seam: persona stub (ok), real event recorder against the real
// fleet DB — the same wiring server.js installs, minus the app.
const seamCtx = {
  session: { model: { id: "stub" } },
  taskTurnRegistry: new Map(),
  // 恒就绪替身（§15.113 续记十二同族第五处）：切片⑤给 manual 任务派生 sourceTag
  // （origin.fleet）后，事件唤醒任务算舰队任务——runCronJobTurn 的就绪预门对它生效，
  // bridge 缺席会按 RUNTIME_READY_WAIT_MS 空等 120s 再 skipped。
  dshBridge: { isReady: () => true },
  recordFleetTurnEvent: (job, outcome, meta) =>
    recordTurnEvent(fleetDb, job, outcome, { ...meta, rosterPresetId: (id) => `roster:${id}` }),
  triggerFleetHandoffs: async () => null,
};
attachCronRunner(seamCtx, {
  runPersona: async () => ({ ok: true, text: "已收到事件" }),
  runA2a: async () => ({ ok: true }),
  listAgents: () => [],
});

before(async () => {
  await db.initDb();
  await chatHistory.initChatHistory();
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: async (job) => seamCtx.runCronJobTurn(job),
    isBusy: () => false,
  });

  const app = express();
  const jsonBodyParser = express.json();
  app.use((req, res, next) => (req.path.startsWith(WEBHOOK_PREFIX) ? next() : jsonBodyParser(req, res, next)));
  ctx = createAppContext({ AUTH_MODE: "none" });
  ctx.app = app;
  // The REAL wake wiring (mirror of server.js): bots.js calls this after its
  // inbound guards; the real module scans the fleet DB and creates the task.
  ctx.triggerFleetEventWake = (botId, meta) =>
    triggerFleetEventWake({ db: fleetDb, engine, roster: (id) => `roster:${id}` }, botId, meta);
  ctx.dshBridge = {
    isReady: () => true,
    async prompt(sessionId, blocks) {
      void sessionId; void blocks;
      queueMicrotask(() => {
        const collector = ctx.sessionCollectors.get(sessionId);
        collector?.({ method: "session.status", params: { sessionId, status: "idle" } });
      });
      return "msg-1";
    },
  };
  registerAuth(ctx);
  registerBotRoutes(ctx);
  bots.initBots(ctx);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  bots.stopAll();
  await engine.idle?.();
  server?.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const postJson = (p, body) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// A feishu bot with dummy outbound credentials — inbound verification ignores
// them (encryptKey/token are optional); sendText is captured, never sent.
async function makeFeishuBot(name) {
  const res = await postJson("/api/bots", {
    type: "feishu",
    name,
    credentials: { appId: "e2e-app", appSecret: "e2e-secret" },
  });
  const botText = await res.text();
  assert.equal(res.status, 200, botText);
  const bot = JSON.parse(botText);
  const entry = bots.getEntry(bot.id);
  entry.adapter = { ...entry.adapter, start: undefined, async sendText() {} };
  return bot;
}

const feishuMessage = (text) => ({
  header: { event_type: "im.message.receive_v1" },
  event: {
    sender: { sender_id: { open_id: "ou-e2e" } },
    message: { message_type: "text", content: JSON.stringify({ text }), chat_id: "oc-e2e" },
  },
});

async function waitFor(predicate, label, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("timeout: " + label);
}

test("a real webhook message wakes the bound post end to end", async () => {
  // Fleet + persona post + event edge bound to the bot.
  const fleet = fleetDb.createFleet({ id: "f_e2e", name: "验收-EventE2E", ownerEmail: "owner@local" });
  fleetDb.createMember({ id: "m_duty", fleetId: fleet.id, title: "值班岗", targetKind: "persona", targetId: "duty-persona", kpiSlots: [], cadence: null });

  const bot = await makeFeishuBot("验收-EventBot");
  fleetDb.updateFleet(fleet.id, {
    orchestration: { mode: "schedule", edges: [{ kind: "event", from: `bot:${bot.id}`, to: "m_duty" }] },
  });

  // The platform-shaped inbound, over the real HTTP webhook route.
  const res = await postJson(`/api/bots/webhook/${bot.id}/${bot.webhookUrl.split("/").pop()}`, feishuMessage("E2E 验收:事件唤醒"));
  assert.equal(res.status, 200);

  // The wake task: real engine record with BOTH origin segments.
  await waitFor(() => {
    const recs = (engine.allRecords?.() ?? []).filter((t) => t.trigger === "manual" && t.origin?.event?.botId === bot.id);
    return recs.length === 1;
  }, "manual task with origin.event");
  const task = engine.allRecords().find((t) => t.origin?.event?.botId === bot.id);
  assert.equal(task.preset, "roster:duty-persona");
  assert.deepEqual(task.origin.fleet, { fleetId: "f_e2e", memberId: "m_duty", depth: 0 });
  assert.deepEqual(task.origin.event, { botId: bot.id, chatKey: "oc-e2e" });
  assert.ok(task.prompt.includes("E2E 验收:事件唤醒"));
  assert.ok(task.prompt.includes("ou-e2e"), "sender rides the brief");
  // add-fleet-edge-context D1: a woken persona post asks for the fleet view;
  // the engine's injection seam is what turns this token into a segment.
  assert.ok(task.prompt.endsWith("{{fleetEdgeContext}}"), "wake prompt carries the edge-context token");
  assert.equal(task.origin.fleet.fleetId, "f_e2e", "and the sourceTag it renders from exists");

  // The turn runs through the seam and lands an O1 event with source=event.
  await waitFor(() => (fleetDb.latestTurnFor("m_duty") ?? {}).status === "ok", "woken turn completes");
  const ev = fleetDb.latestTurnFor("m_duty");
  assert.equal(ev.source, "event");
  assert.equal(ev.status, "ok");
  assert.equal(ev.model, "stub", "model metadata = the seam's landed-model fallback in this harness");

  // The contract reads it as an event wake.
  const request = buildTurnRequest(task);
  assert.equal(request.source, "event");
  assert.equal(request.depth, 0);
});

test("a message for a bot with no event edge disturbs nothing", async () => {
  const other = await makeFeishuBot("无边缘-bot");
  const before = fleetDb.listTurnEvents("m_duty", { limit: 50 }).length;
  const tasksBefore = engine.allRecords().filter((t) => t.origin?.event).length;
  const res = await postJson(`/api/bots/webhook/${other.id}/${other.webhookUrl.split("/").pop()}`, feishuMessage("无关消息"));
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fleetDb.listTurnEvents("m_duty", { limit: 50 }).length, before, "no new events");
  assert.equal(engine.allRecords().filter((t) => t.origin?.event).length, tasksBefore, "no new wake tasks");
});

// ── gateway resolve: owner_email preference (fix-gateway-bot-owner) ────────

test("gateway resolve: row owner_email wins over session inference; legacy rows fall back", async () => {
  const { createBotWebhookRouter } = await import("../gateway/bot-webhooks.js");
  const Database = (await import("better-sqlite3")).default;
  const fs2 = await import("node:fs");
  const root = fs2.mkdtempSync(path.join(os.tmpdir(), "gw-resolve-"));
  const mkCell = (hex, withBot, ownerEmail, sessionOwner) => {
    const dir = path.join(root, hex, "data", "data");
    fs2.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, "app.db"));
    db.exec(`CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT, enabled INTEGER DEFAULT 1, owner_email TEXT)`);
    db.exec(`CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, owner TEXT)`);
    if (withBot) {
      db.prepare("INSERT INTO bots (id, name, owner_email) VALUES (?, ?, ?)").run(withBot.id, "b", ownerEmail ?? null);
    }
    if (sessionOwner) {
      db.prepare("INSERT INTO chat_sessions (id, owner) VALUES (?, ?)").run("s1", sessionOwner);
    }
    db.close();
  };
  mkCell("aaaaaaaaaaaaaaaa", { id: "bot-with-owner" }, "creator@test", "someone-else@test");
  mkCell("bbbbbbbbbbbbbbbb", { id: "bot-legacy" }, null, "legacy-owner@test");
  mkCell("cccccccccccccccc", null, null, "innocent@test");

  const router = createBotWebhookRouter({ dataRoot: root, openDb: (p) => new Database(p, { readonly: true }) });
  const withOwner = router.resolve("bot-with-owner");
  assert.equal(withOwner.email, "creator@test", "row creator email wins over session inference");
  assert.equal(withOwner.userId, "aaaaaaaaaaaaaaaa");
  const legacy = router.resolve("bot-legacy");
  assert.equal(legacy.email, "legacy-owner@test", "legacy row falls back to session inference");
  const none = router.resolve("bot-unknown");
  assert.equal(none.email, null, "unknown bot → unrouteable");
  fs2.rmSync(root, { recursive: true, force: true });
});
