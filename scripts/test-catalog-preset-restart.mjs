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
// The real cadence is 5s (lib/catalog-restart-retry.js); a unit test needs the
// same behaviour on a runnable clock.
process.env.CATALOG_RESTART_RETRY_MS = "20";
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
    // Mirrors dsh-bridge: the flag is true for the WHOLE restart (shutdown →
    // spawn → initialize), which is exactly the window a caller must not read
    // "no roster" from.
    restarting: false,
    restarts: [],
    isReady() {
      return this.ready;
    },
    isRestarting() {
      return this.restarting === true;
    },
    hasLiveMethod: () => true,
    cancelSession: async () => {},
    prompt: async () => "mid-1",
    // A real child composes its roster from the overlay it read at spawn, so the
    // faithful fake reads what is on disk NOW (dshProfile.catalogPresetDefinitions)
    // and always carries the shipped standard row. `rosterOverride` models the
    // stale case: the restart returned but the child never picked the rewrite up.
    // Assigned below (not inline) so it closes over `bridge`: an arrow in the
    // object literal would see the module scope, not this bridge.
    rosterOverride: null,
    restart(args = {}) {
      if (this.restarting) {
        // The real bridge's refusal, verbatim enough for the caller's match.
        return Promise.reject(new Error("dsh restart already in progress (running 0s)"));
      }
      this.ready = false;
      this.restarting = true;
      const call = { args };
      call.promise = new Promise((resolve) => {
        call.finish = () => {
          this.restarting = false;
          this.ready = true;
          ctx.handleDshEvent({ method: "bridge.ready", params: {} });
          resolve({});
        };
      });
      this.restarts.push(call);
      return call.promise;
    },
  };
  bridge.listPresets = async () => {
    if (bridge.rosterOverride) return bridge.rosterOverride;
    // A case hook: runs AFTER the roster is composed but BEFORE it is returned,
    // i.e. inside the window a real switch has to survive (a background restart
    // — skills patch, crash recovery — grabbing the bridge right there).
    if (bridge.afterListPresets) {
      const fn = bridge.afterListPresets;
      bridge.afterListPresets = null;
      fn();
    }
    const dshProfile = await import("../dsh-profile.js");
    return [
      { id: "standard", name: "Standard" },
      ...dshProfile.catalogPresetDefinitions().map((d) => ({ id: d.id, name: d.name })),
    ];
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

  // No immediate re-fire (the bounded self-retry in lib/catalog-restart-retry.js
  // waits 5s and is capped — it is deliberately not a tight loop); the next idle
  // transition still delivers it.
  await tick();
  await tick();
  assert.equal(bridge.restarts.length, 1, "no immediate self-retry spin");
  fail = false;
  ctx.onRuntimeIdle();
  await tick();
  assert.equal(bridge.restarts.length, 2, "the next idle transition retries");
  bridge.restarts[1].finish();
  await tick();
  assert.equal(ctx.catalogPresetRestartPending, false);
});

test("a restart onto a stale roster is not a delivery", async () => {
  const ctx = makeCtx();
  const bridge = ctx.dshBridge;

  // The child keeps composing the OLD roster (the collision case: another
  // deferred restart spawned it first), so this restart "succeeds" while the
  // catalog agent is still missing from the runtime.
  bridge.rosterOverride = [{ id: "standard", name: "Standard" }];
  addPreset();
  // NOT awaited inline: the sync resolves when the restart it started finishes,
  // so the fake's finish() has to happen first (same pattern as the cases above).
  const sync = ctx.syncCatalogAgentPresets();
  await tick();
  assert.equal(bridge.restarts.length, 1);
  bridge.restarts[0].finish();
  await sync;
  await tick();
  await tick();
  assert.equal(
    ctx.catalogPresetRestartPending,
    true,
    "roster written but absent from the child ⇒ still pending, not delivered",
  );

  // Once the child composes it, the retry delivers and clears the flag.
  bridge.rosterOverride = null;
  ctx.onRuntimeIdle();
  await tick();
  assert.equal(bridge.restarts.length, 2, "the pending rewrite is still tried");
  bridge.restarts[1].finish();
  await tick();
  await tick();
  assert.equal(ctx.catalogPresetRestartPending, false, "delivered once the child lists the roster");
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

// ── The restart WINDOW is not "no roster" ───────────────────────────────────
// Measured 2026-11-14 (focus-overlay:289): the e2e pack install triggers the
// catalog/skills restart, the switch issued right after it landed inside the
// spawn, getAgentPresets() answered [] (isReady() is false for the whole
// restart) and the user got "No agent modes are available in this deployment".
// A restart in flight is "down and coming back"; only a bridge that is down with
// NOTHING in flight is honestly empty.

test("a roster read during an in-flight restart waits for it instead of answering empty", async () => {
  const ctx = makeCtx();
  const bridge = ctx.dshBridge;
  const row = addPreset();

  const sync = ctx.syncCatalogAgentPresets();
  await tick();
  assert.equal(bridge.restarts.length, 1, "the roster change restarted the child");
  assert.equal(bridge.isReady(), false, "and the child is not ready while it restarts");

  // A client asks for the roster now: it must not see the empty deployment.
  let resolved = null;
  const read = ctx.getAgentPresets().then((r) => {
    resolved = r;
    return r;
  });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(resolved, null, "the read is still waiting on the restart, not answering []");

  bridge.restarts[0].finish();
  const roster = await read;
  await sync;
  const dshProfile = await import("../dsh-profile.js");
  const wantId = dshProfile.rosterPresetId(row.id);
  assert.ok(
    roster.some((p) => p.id === wantId),
    `the roster the read returns lists the preset written before the restart: ${JSON.stringify(roster.map((p) => p.id))}`,
  );
  assert.ok(
    roster.some((p) => p.id === "standard"),
    "the built-in agent is selectable (this was the user-visible failure)",
  );

  // And a bridge that is down with nothing in flight still answers honestly:
  // no restart to wait for ⇒ no invented wait.
  bridge.ready = false;
  bridge.restarting = false;
  const startedAt = Date.now();
  assert.deepEqual(await ctx.getAgentPresets(), []);
  assert.ok(Date.now() - startedAt < 1000, "a genuinely dead bridge is not waited on");
});

test("a preset switch colliding with a background restart waits instead of failing", async () => {
  const ctx = makeCtx();
  const bridge = ctx.dshBridge;
  const dshProfile = await import("../dsh-profile.js");
  const row = addPreset();
  const targetId = dshProfile.rosterPresetId(row.id);

  // Get the preset into the child's roster the ordinary way (a catalog sync
  // delivers it through its own restart) — then the collision case starts from
  // a ready bridge, like the real one after the install settled.
  const sync0 = ctx.syncCatalogAgentPresets();
  await tick();
  assert.equal(bridge.restarts.length, 1, "the catalog sync delivered the preset");
  bridge.restarts[0].finish();
  await sync0;
  assert.equal(bridge.isReady(), true);

  // The collision window: a background restart (skills patch, crash recovery)
  // starts right AFTER the switch read the roster and BEFORE it could restart.
  let background = null;
  bridge.afterListPresets = () => {
    background = bridge.restart({});
  };

  const switching = ctx.switchPresetTo(targetId);
  const until = async (pred, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    return pred();
  };
  assert.ok(await until(() => background !== null), "the background restart owns the bridge");
  // Parked on the owner: no failure, and no second restart stacked on the first.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(bridge.restarts.length, 2, "the switch waits for the owner instead of racing it");

  bridge.restarts[1].finish();
  await background.catch(() => {});
  assert.ok(await until(() => bridge.restarts.length === 3), "the switch runs its restart once the bridge is free");
  assert.equal(bridge.restarts[2].args.agentPreset, targetId, "and it baked the requested preset into initialize");
  bridge.restarts[2].finish();
  const r = await switching;
  assert.deepEqual(r, { ok: true }, `the switch succeeded after the owner finished: ${JSON.stringify(r)}`);
  await tick();
  assert.equal(ctx.currentPreset, targetId, "the choice became the deployment default");
});

// ── A long busy stretch must not consume the delivery budget ────────────────
// Measured 2026-11-14 (full e2e run, focus-overlay:174 / pack-agent-scoping:144):
// the pack install wrote the roster while the shared child was busy; three
// declines landed inside that one stretch, the shared 3-attempt budget expired
// ("still undelivered after 3/3 attempt(s)"), and the rewrite then waited for an
// idle transition that the busy stretch itself guaranteed would not arrive
// before the test's 90s window ran out. A decline is not a failure: it keeps
// looking on its own cadence, and the roster lands as soon as the child is free
// — with or without an idle event.

test("a busy stretch longer than the failure budget still delivers once the child frees up", async () => {
  const ctx = makeCtx();
  const bridge = ctx.dshBridge;
  const dshProfile = await import("../dsh-profile.js");
  const row = addPreset();
  const wantId = dshProfile.rosterPresetId(row.id);

  // The dispatcher's own definition of busy: an open web turn streaming.
  const session = "platform-S";
  ctx.webTurnSessions.add(session);
  ctx.turnStateFor(session).origin = { user: null, sessionId: session };
  ctx.setStreaming(session, true);

  await ctx.syncCatalogAgentPresets();
  assert.equal(bridge.restarts.length, 0, "never restart under an open turn");
  assert.equal(ctx.catalogPresetRestartPending, true, "the rewrite is remembered");

  // Declines pile up for longer than the FAILURE budget (3). With the old shared
  // budget this is exactly where the episode died.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(200); // 20ms cadence ⇒ ~10 looks, i.e. > 3
  assert.equal(bridge.restarts.length, 0, "still busy: still not restarting");
  assert.equal(ctx.catalogPresetRestartPending, true, "and still pending, not abandoned");

  // The turn ends. NO idle event is sent: the scheduled look alone must converge.
  ctx.setStreaming(session, false);
  ctx.webTurnSessions.delete(session);
  const deadline = Date.now() + 3000;
  while (bridge.restarts.length === 0 && Date.now() < deadline) await sleep(20);
  assert.equal(bridge.restarts.length, 1, "the look after the busy stretch restarted the child");
  bridge.restarts[0].finish();
  await sleep(50);
  assert.equal(ctx.catalogPresetRestartPending, false, "delivered — the roster reached the child");
  assert.ok((ctx.presetRoster ?? []).some((p) => p.id === wantId), "and the child lists it");
});
