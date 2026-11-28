#!/usr/bin/env node
// ── The synchronous room-turn endpoint ──────────────────────────────────────
//
// A Zhiyu room calls an agent seat synchronously — `await callAgent(...)` must
// return `{ text }` (gateway/zhiyu/index.js:180). The cell's dispatch face only
// ENQUEUES a task and returns an id, which is the wrong shape: a room wants one
// answer, now. This endpoint is the capability `server/bots.js` already had
// in-process (collectTurn + dshBridge.prompt + await), exposed to the one caller
// that needs it.
//
// The three things this file pins, each a failure we would otherwise ship:
//   · the gateway secret is required, and a browser cannot reach it;
//   · ownership is re-asked HERE, not trusted from a header;
//   · a runtime that cannot run says so instead of hanging the caller.
//
// Run: node --test scripts/test-gateway-turn.mjs

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-turn-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const cron = await import("../cron.js");
const chatHistory = await import("../chat-history.js");
const { initDb } = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { registerGatewayTurnRoutes } = await import("../server/routes/gateway-turn.js");

await initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
await engine.initTaskEngine({ broadcast: () => {}, runTurn: async () => ({ ok: true }), isBusy: () => false });

const fleetDb = createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") });
setFleetDatabase(fleetDb);

const OWNER = "owner@test";
const FLEET = "fleet_turn_1";
const POST = "m_turn_1";

fleetDb.createFleet({ id: FLEET, name: "轮次舰队", ownerEmail: OWNER });
fleetDb.createMember({
  id: POST, fleetId: FLEET, title: "幕僚长", targetKind: "persona", targetId: "user.preset-4",
});

test.after(() => {
  cron.shutdown?.();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** A ctx whose runtime answers with a fixed string, in the collector's shape. */
function makeCtx({ ready = true, answer = "好的，这是答复。" } = {}) {
  const ctx = {
    sessionCollectors: new Map(),
    currentPreset: null,
    streaming: [],
    switchedTo: [],
    setStreaming(sessionId, on) { this.streaming.push({ sessionId, on }); },
    async switchPresetTo(id) {
      this.currentPreset = id;
      this.switchedTo.push(id);
      return { ok: true };
    },
    dshBridge: {
      isReady: () => ready,
      prompts: [],
      async prompt(sessionId) {
        this.prompts.push(sessionId);
        queueMicrotask(() => {
          const collector = ctx.sessionCollectors.get(sessionId);
          if (!collector) return;
          // The collector reads `session.event` notifications and takes the
          // text from an assistant message's content blocks — NOT a bare
          // {type:"text"} event (that shape reads as "no output", which is how
          // this test first failed).
          collector({
            method: "session.event",
            params: {
              sessionId,
              event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: answer }] } } },
            },
          });
          collector({ method: "session.status", params: { sessionId, status: "idle" } });
        });
        return "msg-1";
      },
    },
  };
  return ctx;
}

async function startServer(ctx) {
  const app = express();
  app.use(express.json());
  registerGatewayTurnRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (body, headers = {}) =>
    fetch(`${base}/api/gateway/sync-turn`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-email": OWNER, ...headers },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { server, call };
}

const VALID = { fleetId: FLEET, memberId: POST, text: "请报一下今天的进度" };

test("a turn returns the post's text synchronously", async () => {
  const ctx = makeCtx({ answer: "今天三件事已完成。" });
  const { server, call } = await startServer(ctx);
  try {
    const r = await call(VALID);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.text, "今天三件事已完成。", "the room gets the answer in the response, not from somewhere else");
    assert.deepEqual(ctx.switchedTo, ["user-preset-4"], "the runtime was switched to the post's persona — the ROSTER spelling, dotted catalog ids folded");
    assert.equal(ctx.dshBridge.prompts.length, 1, "exactly one prompt was issued");
    // The streaming flag must be set for the duration and cleared after — the
    // bot lane learned this the hard way (a credential restart sees "idle" and
    // kills the runtime mid-turn otherwise).
    assert.deepEqual(ctx.streaming.map((s) => s.on), [true, false]);
  } finally {
    server.close();
  }
});

test("the gateway secret is required when one is configured", async () => {
  process.env.CELL_GATEWAY_SECRET = "s3cret";
  const ctx = makeCtx();
  const { server, call } = await startServer(ctx);
  try {
    const denied = await call(VALID);
    assert.equal(denied.status, 401, "no secret ⇒ no turn (a browser must not drive the runtime)");
    assert.equal(ctx.dshBridge.prompts.length, 0, "and nothing ran");

    const allowed = await call(VALID, { "x-cloud-gateway-secret": "s3cret" });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.ok, true);
  } finally {
    delete process.env.CELL_GATEWAY_SECRET;
    server.close();
  }
});

test("someone else's fleet answers exactly like a missing one", async () => {
  const ctx = makeCtx();
  const { server, call } = await startServer(ctx);
  try {
    const foreign = await call({ ...VALID }, { "x-forwarded-email": "someone-else@test" });
    const missing = await call({ ...VALID, fleetId: "fleet_nope" });
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(foreign.body, missing.body, "no oracle: both are the same body");
    assert.equal(ctx.dshBridge.prompts.length, 0, "neither ran a turn");
  } finally {
    server.close();
  }
});

test("a post from another fleet is refused", async () => {
  fleetDb.createFleet({ id: "fleet_other", name: "别队", ownerEmail: OWNER });
  fleetDb.createMember({ id: "m_other", fleetId: "fleet_other", title: "外人", targetKind: "persona", targetId: "user.preset-5" });
  const ctx = makeCtx();
  const { server, call } = await startServer(ctx);
  try {
    const r = await call({ ...VALID, memberId: "m_other" });
    assert.equal(r.status, 404, "a member id alone must not reach across fleets");
    assert.equal(ctx.dshBridge.prompts.length, 0);
  } finally {
    server.close();
  }
});

test("a runtime that is not ready says so instead of hanging", async () => {
  const ctx = makeCtx({ ready: false });
  const { server, call } = await startServer(ctx);
  try {
    const r = await call(VALID);
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "runtime_not_ready");
    assert.equal(ctx.dshBridge.prompts.length, 0, "no prompt was issued into a dead runtime");
  } finally {
    server.close();
  }
});

test("bad input is refused before anything runs", async () => {
  const ctx = makeCtx();
  const { server, call } = await startServer(ctx);
  try {
    for (const bad of [{}, { ...VALID, text: "" }, { ...VALID, memberId: "" }, { ...VALID, timeoutMs: -1 }]) {
      const r = await call(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal(ctx.dshBridge.prompts.length, 0);
  } finally {
    server.close();
  }
});

// ── Persona composition: park, don't restart (2026-11-24) ──────────────────
//
// The restart ladder (switchPresetForJob) switches the CELL's live runtime,
// which also yanks the owner's own chat onto the post's persona. A room turn has
// no business doing that. The cron lane already parks per-session; this lane
// must too when the child supports it.

test("a child that supports preset/set parks the persona instead of restarting", async () => {
  const ctx = makeCtx({ answer: "parked answer" });
  const parked = [];
  ctx.dshBridge.hasLiveMethod = (m) => m === "preset/set";
  ctx.dshBridge.setPreset = async ({ sessionId, presetId }) => {
    parked.push({ sessionId, presetId });
    ctx.dshBridge.preparedPresetMap?.set(sessionId, presetId);
    return true;
  };
  ctx.dshBridge.preparedPreset = (sid) => ctx.dshBridge.preparedPresetMap?.get(sid) ?? null;
  ctx.dshBridge.preparedPresetMap = new Map();
  const { server, call } = await startServer(ctx);
  try {
    const r = await call(VALID);
    assert.equal(r.status, 200);
    assert.equal(r.body.text, "parked answer");
    assert.equal(parked.length, 1, "the persona was parked on the room's session");
    assert.equal(parked[0].presetId, "user-preset-4", "and with the roster spelling");
    assert.deepEqual(ctx.switchedTo, [], "the owner's live runtime was NOT switched — no restart");
    assert.equal(ctx.dshBridge.prompts.length, 1);
  } finally {
    server.close();
  }
});

test("a child without preset/set falls back to the restart ladder (recorded, not silent)", async () => {
  const ctx = makeCtx({ answer: "legacy answer" });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  const { server, call } = await startServer(ctx);
  try {
    const r = await call(VALID);
    assert.equal(r.body.text, "legacy answer");
    assert.deepEqual(ctx.switchedTo, ["user-preset-4"], "no park ⇒ the explicit ladder runs");
    assert.ok(warns.some((w) => w.includes("preset park unavailable")), "the fallback says so in the log");
  } finally {
    console.warn = origWarn;
    server.close();
  }
});
