// Deterministic reproduction of the 2026-10-20 production failure: the
// catalog-preset sync rewrote the roster overlay while the child was already
// restarting for the previous rewrite, skipped its own restart because the
// bridge was not ready, and never came back to it. The child then composed the
// narrower roster for the rest of the cell's life and every prompt on a
// cloud-merged agent failed with "Unknown agent preset".
//
// The composition is the real one (context → dsh-events → runtime-bindings →
// agent-session → turn-dispatch, the server.js order); only the bridge is a
// fake whose restart stays in flight until the test lets it finish — the same
// shape as dsh-bridge, which fires bridge.ready from inside restart() right
// before resolving it.
//
// Run: node --test scripts/test-catalog-preset-restart.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-preset-restart-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DSH_HOME = path.join(tmpRoot, "dsh-home");
process.env.MCP_CONFIG_PATH = path.join(tmpRoot, "mcp.json");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });
fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));

// catalog.js binds its agents.json at import; the repo's own must never be
// read here. The custom-preset source (DB rows) is what moves the roster.
const cwdFixture = path.join(tmpRoot, "cwd");
fs.mkdirSync(cwdFixture, { recursive: true });
fs.writeFileSync(path.join(cwdFixture, "agents.json"), JSON.stringify({ agents: [], apps: [] }));
process.chdir(cwdFixture);

const db = await import("../db.js");
const chatHistory = await import("../chat-history.js");
const { createAppContext } = await import("../server/context.js");
const { attachDshEvents } = await import("../server/dsh-events.js");
const { attachRuntimeBindings } = await import("../server/runtime-bindings.js");
const { attachAgentSession } = await import("../server/agent-session.js");
const { attachTurnDispatch } = await import("../server/turn-dispatch.js");

await db.initDb();

let context = null;
const sm = {
  getSessionId: () => context.dshSessionId,
  getSessionFile: () => null,
  buildSessionContext: () => ({ messages: [] }),
  newSession: () => {
    context.dshSessionId = "platform-new-" + Math.random().toString(36).slice(2, 8);
  },
  setSessionId: (id) => {
    context.dshSessionId = id;
  },
  setSessionFile: () => {},
};
chatHistory.setSessionManager(sm);
chatHistory.setPresetSource(() => "standard");
chatHistory.setWorkspaceSource(() => null);

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const tick = () => new Promise((r) => setImmediate(r));

// A bridge whose restart() behaves like dsh-bridge's: readiness drops at once,
// bridge.ready fires from inside the call right before it resolves — but only
// when the test says so, which is what lets a second sync land mid-restart.
function makeBridge(ctx) {
  const bridge = {
    ready: true,
    restarts: [],
    isReady() {
      return this.ready;
    },
    hasLiveMethod: () => true,
    cancelSession: async () => {},
    prompt: async () => "mid-1",
    listPresets: async () => [],
    restart() {
      this.ready = false;
      const call = {};
      call.promise = new Promise((resolve) => {
        call.finish = () => {
          this.ready = true;
          ctx.handleDshEvent({ method: "bridge.ready", params: {} });
          resolve({});
        };
      });
      this.restarts.push(call);
      return call.promise;
    },
  };
  return bridge;
}

let presetSeq = 0;
function addPreset() {
  presetSeq += 1;
  return db.createUserPreset({ name: `Preset ${presetSeq}`, persona: `persona ${presetSeq}` });
}

function makeCtx() {
  const ctx = createAppContext({});
  ctx.broadcast = () => {};
  ctx.broadcastSessions = async () => {};
  ctx.db = db;
  ctx.session = {
    prompt: async () => {},
    model: { id: "m", provider: "p" },
    sessionManager: sm,
  };
  ctx.dshBridge = makeBridge(ctx);
  ctx.sendToViewers = () => {};
  attachDshEvents(ctx);
  attachRuntimeBindings(ctx);
  attachAgentSession(ctx);
  attachTurnDispatch(ctx);
  ctx.dshSessionId = "platform-S";
  context = ctx;
  return ctx;
}

test("a roster rewrite that lands mid-restart is delivered at that restart's bridge.ready", async () => {
  const ctx = makeCtx();
  const bridge = ctx.dshBridge;

  // Sync #1: the roster changed, the child is idle → restart #1 begins.
  addPreset();
  const sync1 = ctx.syncCatalogAgentPresets();
  await tick();
  assert.equal(bridge.restarts.length, 1, "an idle child restarts for a changed roster");
  assert.equal(bridge.isReady(), false);

  // Sync #2 while restart #1 is in flight (the boot-time cloud merge): the
  // overlay is rewritten, the bridge is not ready → no restart NOW …
  addPreset();
  await ctx.syncCatalogAgentPresets();
  assert.equal(bridge.restarts.length, 1, "a bridge that is mid-restart is not restarted again");
  assert.equal(ctx.catalogPresetRestartPending, true, "… but the rewrite is remembered");

  // Restart #1 completes: its bridge.ready must pick the pending rewrite up.
  bridge.restarts[0].finish();
  await sync1;
  await tick();
  assert.equal(bridge.restarts.length, 2, "the skipped rewrite restarts the child once it is ready");
  assert.equal(ctx.catalogPresetRestartPending, false);

  // Restart #2 completes with nothing new on disk: no third restart (no loop).
  bridge.restarts[1].finish();
  await tick();
  await tick();
  assert.equal(bridge.restarts.length, 2, "a delivered rewrite must not restart again");
  assert.equal(ctx.runtimeReservations.size, 0, "the restart's reservation is released");
});

test("a roster rewrite under an open turn is delivered when the turn closes", async () => {
  const ctx = makeCtx();
  const bridge = ctx.dshBridge;

  ctx.webTurnSessions.add("platform-S");
  ctx.turnStateFor("platform-S").origin = { user: null, sessionId: "platform-S" };
  ctx.setStreaming("platform-S", true);

  addPreset();
  await ctx.syncCatalogAgentPresets();
  assert.equal(bridge.restarts.length, 0, "never restart under an open turn");
  assert.equal(ctx.catalogPresetRestartPending, true);

  // The turn closes → finishTurn → idle transition → the restart lands.
  ctx.handleDshEvent({ method: "session.status", params: { sessionId: "platform-S", status: "idle" } });
  await tick();
  assert.equal(bridge.restarts.length, 1, "the deferred restart runs at the idle transition");
  bridge.restarts[0].finish();
  await tick();
  assert.equal(bridge.restarts.length, 1);
});

test("a queued prompt waits for the deferred restart instead of running on the stale child", async () => {
  const ctx = makeCtx();
  const bridge = ctx.dshBridge;

  ctx.webTurnSessions.add("platform-S");
  ctx.turnStateFor("platform-S").origin = { user: null, sessionId: "platform-S" };
  ctx.setStreaming("platform-S", true);

  let qRan = false;
  const receipt = ctx.dispatchTurn({
    sessionId: "platform-Q",
    text: "queued",
    run: async () => {
      qRan = true;
    },
  });
  assert.equal(receipt.queued, true);

  addPreset();
  await ctx.syncCatalogAgentPresets();
  assert.equal(ctx.catalogPresetRestartPending, true);

  // S closes: the restart must take the idle slot ahead of the queued prompt.
  ctx.handleDshEvent({ method: "session.status", params: { sessionId: "platform-S", status: "idle" } });
  await tick();
  assert.equal(bridge.restarts.length, 1, "the restart goes first");
  assert.equal(qRan, false, "the queued prompt must not run on the child being restarted");

  // The fresh child is ready → the queue drains onto it.
  bridge.restarts[0].finish();
  await tick();
  assert.equal(qRan, true, "the queued prompt runs once the fresh child is ready");
  assert.equal(ctx.runtimeReservations.size, 0);
});

test("a failed restart keeps the rewrite pending for the next idle transition", async () => {
  const ctx = makeCtx();
  const bridge = ctx.dshBridge;
  let fail = true;
  const realRestart = bridge.restart.bind(bridge);
  bridge.restart = function () {
    if (fail) {
      this.restarts.push({ failed: true });
      return Promise.reject(new Error("dsh restart already in progress"));
    }
    return realRestart();
  };

  addPreset();
  await ctx.syncCatalogAgentPresets();
  assert.equal(bridge.restarts.length, 1);
  assert.equal(ctx.catalogPresetRestartPending, true, "a failed restart leaves the rewrite pending");

  // Nothing re-fires on its own (the bridge stayed "ready" in this fake, so a
  // self-retry would spin); the next idle transition delivers it.
  await tick();
  await tick();
  assert.equal(bridge.restarts.length, 1, "no self-retry spin");
  fail = false;
  ctx.onRuntimeIdle();
  await tick();
  assert.equal(bridge.restarts.length, 2, "the next idle transition retries");
  bridge.restarts[1].finish();
  await tick();
  assert.equal(ctx.catalogPresetRestartPending, false);
});

test("a returning roster entry restores the agent label from local", async () => {
  const ctx = makeCtx();
  const agentEvents = [];
  ctx.broadcast = (m) => {
    if (m?.type === "agent_changed") agentEvents.push(m.id);
  };

  // The mid-outage state: the roster (re)gains an agent while the cell's label
  // fell back to `local` and the live preset is that agent's.
  const row = addPreset();
  const dshProfile = await import("../dsh-profile.js");
  ctx.currentAgentId = "local";
  ctx.currentPreset = dshProfile.rosterPresetId(row.id);

  const syncP = ctx.syncCatalogAgentPresets();
  await tick();
  assert.equal(ctx.currentAgentId, row.id, "the label follows the preset back to its catalog agent");
  assert.deepEqual(agentEvents, [row.id]);
  for (const call of ctx.dshBridge.restarts) call.finish?.();
  await syncP;

  // A remote-agent selection (a catalog id with no generated preset) is never
  // stomped by preset derivation: the gone-branch still owns it.
  const ctx2 = makeCtx();
  const events2 = [];
  ctx2.broadcast = (m) => {
    if (m?.type === "agent_changed") events2.push(m.id);
  };
  ctx2.currentAgentId = "registry-packs-remote-agent";
  ctx2.currentPreset = "standard";
  const sync2 = ctx2.syncCatalogAgentPresets();
  await tick();
  assert.deepEqual(events2, ["local"], "a departed remote agent falls back to local, never mislabeled as a pack agent");
  for (const call of ctx2.dshBridge.restarts) call.finish?.();
  await sync2;
});
