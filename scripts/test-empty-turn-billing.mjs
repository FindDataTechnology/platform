// Unit tests — empty-turn billing (F3.3 remainder, fix-error-turn-billing).
//
// The UNKNOWN_MODEL silent empty return never emits a platform/stream error
// finish frame; its ONLY failure signature is turn/end reason=error. Before
// this fix the collector ignored turn/end entirely and attempt() rode
// ok:true with an error field into billing — a zero-output failure billed
// like a success. Pins:
//   - collectTurn captures turn/end reason=error even with no stream finish
//   - runPersonaTurn settles such turns ok:false (billing reads outcome ok)
//   - a healthy turn (no error frames) still settles ok:true
//
// Run: node --test scripts/test-empty-turn-billing.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "empty-turn-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const dbModule = await import("../db.js");
await dbModule.initDb();
await (await import("../chat-history.js")).initChatHistory();
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { collectTurn, runPersonaTurn } = await import("../server/cron-runner.js");

let fleetDb;
before(() => {
  fleetDb = createFleetDatabase({ file: path.join(tmpRoot, `fleets-${Date.now()}.db`) });
  setFleetDatabase(fleetDb);
});
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const DECLARED = "deepseek-v4.1-flash";

function baseCtx() {
  const collectors = new Map();
  return {
    collectors,
    ctx: {
      sessionCollectors: collectors,
      onRuntimeIdle: () => {},
      isStreaming: false,
      sessionVersion: 1,
      broadcast: () => {},
      session: { model: { id: DECLARED } },
      dshModels: [{ id: DECLARED, provider: "deepseek" }],
      llmLaneForModel: () => null,
      recordFleetModelNotices: () => {},
      resolveFleetIdentity: null,
      // Both jobs below carry `sourceTag.fleetId`, so the round goes through
      // normalizeModelForJob — and a fleet-attributed job with NO plan is now
      // refused before it runs ("post model resolution unavailable …", ledger
      // E28). Without this the healthy case settles ok:false for a reason that
      // has nothing to do with what this file pins (empty-turn billing), and
      // the error case matches the refusal prose instead of the upstream
      // UNKNOWN_MODEL that actually describes the failure.
      resolveFleetModel: async (preset) => ({
        memberId: "m_1",
        preset,
        candidates: [{ model: DECLARED }],
        notices: [],
        explicitChain: false,
      }),
      switchModelTo: async () => ({ ok: true }),
      dshBridge: {
        isReady: () => true,
        hasLiveMethod: () => true,
        setPreset: async () => {},
        preparedPreset: () => undefined,
        deleteSession: async () => {},
        prompt: async () => {},
      },
    },
  };
}

test("collectTurn: turn/end reason=error is captured even with no stream error finish", async () => {
  const { collectors, ctx } = baseCtx();
  const sessionId = "s-empty";
  const collected = collectTurn(ctx, sessionId, 5_000, new Map(), collectors, sessionId);
  const fire = collectors.get(sessionId);
  assert.ok(fire, "collector registered");
  // Tokens were spent (the upstream billed the call) but the turn died.
  fire({ method: "session.event", params: { event: { type: "assistant/message", data: { usage: { input: 120, output: 0 } } } } });
  // The ONLY failure signature — no platform/stream finish frame precedes it.
  fire({ method: "session.event", params: { event: { type: "turn/end", data: { reason: { kind: "error", error: { message: "400 UNKNOWN_MODEL: silent empty return" } } } } } });
  fire({ method: "session.status", params: { status: "idle" } });
  const out = await collected;
  assert.match(out.error, /UNKNOWN_MODEL/, "turn/end error captured");
  assert.ok(out.usage, "the spent tokens are still reported honestly");
});

test("collectTurn: a stream error finish still wins when it fired first (no double-capture)", async () => {
  const { collectors, ctx } = baseCtx();
  const sessionId = "s-stream-err";
  const collected = collectTurn(ctx, sessionId, 5_000, new Map(), collectors, sessionId);
  const fire = collectors.get(sessionId);
  fire({ method: "platform/stream", params: { frame: { chunk: { type: "finish", reason: { kind: "error", failure: { message: "upstream 502" } } } } } });
  fire({ method: "session.event", params: { event: { type: "turn/end", data: { reason: { kind: "error", error: { message: "turn failed" } } } } } });
  fire({ method: "session.status", params: { status: "idle" } });
  const out = await collected;
  assert.equal(out.error, "upstream 502", "first captured error stands");
});

test("runPersonaTurn: silent empty return settles ok:false — never billed as success", async () => {
  const { collectors, ctx } = baseCtx();
  const _childId = "cron-empty#r1";
  ctx.dshBridge.prompt = async (sessionId) => {
    const fire = collectors.get(sessionId);
    // Tokens spent, zero output, turn ends error — the billed-empty shape.
    fire({ method: "session.event", params: { event: { type: "assistant/message", data: { usage: { input: 120, output: 0 } } } } });
    fire({ method: "session.event", params: { event: { type: "turn/end", data: { reason: { kind: "error", error: { message: "400 UNKNOWN_MODEL: silent empty return" } } } } } });
    fire({ method: "session.status", params: { status: "idle" } });
  };
  const job = {
    id: "job_empty",
    sessionId: "cron-empty",
    targetType: "persona",
    preset: "persona-x",
    sourceTag: { fleetId: "f1", memberId: "m1" },
    prompt: "巡视",
    executionCarrier: { carrier: "cell" },
    roundSeq: 1,
  };
  const out = await runPersonaTurn(ctx, job, 5_000, new Map(), { startedAt: Date.now() });
  assert.equal(out.ok, false, "the empty failure must NOT settle as success");
  assert.match(out.error, /UNKNOWN_MODEL/);
});

test("runPersonaTurn: healthy turn (no error frames) still settles ok:true", async () => {
  const { collectors, ctx } = baseCtx();
  ctx.dshBridge.prompt = async (sessionId) => {
    const fire = collectors.get(sessionId);
    fire({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "报数完成" }] }, usage: { input: 100, output: 20 } } } } });
    fire({ method: "session.status", params: { status: "idle" } });
  };
  const job = {
    id: "job_healthy",
    sessionId: "cron-healthy",
    targetType: "persona",
    preset: "persona-x",
    sourceTag: { fleetId: "f1", memberId: "m2" },
    prompt: "巡视",
    executionCarrier: { carrier: "cell" },
    roundSeq: 1,
  };
  const out = await runPersonaTurn(ctx, job, 5_000, new Map(), { startedAt: Date.now() });
  assert.equal(out.ok, true, "healthy turn unchanged");
  assert.equal(out.error ?? null, null);
  assert.equal(out.text, "报数完成");
});
