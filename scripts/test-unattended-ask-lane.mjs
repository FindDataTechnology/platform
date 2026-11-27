// The unattended-ask CANCEL must travel on the bridge the turn is running on
// (fix-unattended-ask-parks-turn, the structural half).
//
// Production evidence that motivated this: 2026-11-14, cell 1da519d4c1c0bf89 —
// nine `carrier=worker` cron rounds each burned the full 480s budget soft stop
// with `lastTool=ask_user_question` and `lastToolWaitedMs≈458s`. The collector
// DID cancel every ask it saw, but `collectTurn` sent that cancel through
// `ctx.dshBridge` — the CELL child — while the ask was pending inside
// `worker.bridge`. The cell answered `{accepted:false}` (no such askId) and the
// `.catch(() => {})` swallowed it, so the round looked cancelled and wasn't.
//
// These two cases pin both directions: an injected bridge is the one used, and
// the cell lane still falls back to the primary bridge.
//
// Run: node --test scripts/test-unattended-ask-lane.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { collectTurn } from "../server/cron-runner.js";

const ASK = (sessionId = "child-1", askId = "ask-1") => ({
  method: "userQuestion/ask",
  params: { sessionId, askId, questions: [{ id: "q1", question: "继续吗？" }] },
});

// A ctx shaped like the ones collectTurn runs against, recording which bridge
// each answer/cancel went out on.
function makeCtx() {
  const calls = { primary: [], injected: [] };
  const ctx = {
    dshBridge: {
      async answerUserQuestion(payload) {
        calls.primary.push(payload);
        // The real cell child has no such askId — that is precisely the silent
        // no-op this test exists to prevent.
        return { accepted: false, reason: "unknown or already-resolved ask" };
      },
    },
    onRuntimeIdle() {},
  };
  return { ctx, calls };
}

// Start a turn, hand back its collector plus the promise (which the caller must
// settle so the timers do not outlive the test).
function startTurn(ctx, collectors, activeTurns, opts = {}) {
  const settled = collectTurn(ctx, "child-1", 5_000, activeTurns, collectors, "member-1", opts);
  const collector = collectors.get("child-1");
  assert.equal(typeof collector, "function", "collectTurn registers its collector synchronously");
  return { collector, settled };
}

const finish = async (collector, settled) => {
  collector({ method: "session.status", params: { sessionId: "child-1", status: "idle" } });
  await settled;
};

// The success side must name itself (2026-11-15): `accepted:false` was logged,
// a landed cancel was not, so "cancelled through the turn's bridge" and "never
// reached this branch" left identical evidence — the 24 h measurement could
// only INFER the path from a 0 s latency.
const captureConsole = (fn, lines = []) => {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => lines.push(["log", a.join(" ")]);
  console.warn = (...a) => lines.push(["warn", a.join(" ")]);
  const task = Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = origLog;
      console.warn = origWarn;
    });
  return { lines, task };
};

test("worker 车道的无人值守问询走该回合自己的桥，不打主桥", async () => {
  const { ctx, calls } = makeCtx();
  const collectors = new Map();
  const activeTurns = new Map();
  const { collector, settled } = startTurn(ctx, collectors, activeTurns, {
    earlyStop: true,
    answerQuestion: async (payload) => {
      calls.injected.push(payload);
      return { accepted: true };
    },
  });

  collector(ASK());
  const { lines, task } = captureConsole(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  await task;

  assert.equal(calls.injected.length, 1, "注入的桥必须收到取消");
  assert.deepEqual(
    calls.injected[0],
    { sessionId: "child-1", askId: "ask-1", cancelled: true },
    "取消载荷照旧：按 askId 取消，带原会话",
  );
  assert.equal(
    calls.primary.length,
    0,
    "worker 回合的取消不得再打到主桥——那正是九轮烧满 480 秒的形态",
  );
  assert.ok(
    lines.some(([, t]) => t.includes("unattended ask cancelled") && t.includes("via=turn")),
    "成功侧必须留下一条点名 via=turn 的行（否则「取消了」与「根本没到这条支路」事后同形）",
  );
  await finish(collector, settled);
});

test("cell 车道（未注入）仍回落到主桥并保持取消语义", async () => {
  const { ctx, calls } = makeCtx();
  const collectors = new Map();
  const activeTurns = new Map();
  const { collector, settled } = startTurn(ctx, collectors, activeTurns, { earlyStop: true });

  collector(ASK("child-2", "ask-2"));
  const { lines, task } = captureConsole(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  await task;

  assert.equal(calls.primary.length, 1, "未注入时回落到主桥（cell 车道的行为不变）");
  assert.deepEqual(calls.primary[0], { sessionId: "child-2", askId: "ask-2", cancelled: true });
  assert.equal(calls.injected.length, 0);
  // This fixture's primary bridge answers `accepted:false` (the real cell child
  // shape for a foreign askId), so the honest line here is the rejection — and
  // it must still name the bridge it went through.
  const reject = lines.find(([, t]) => t.includes("unattended ask not cancelled"));
  assert.ok(reject, "打不到 askId 时必须留住拒绝行");
  assert.ok(reject[1].includes("via=primary"), "拒绝行也要点名 via=primary");
  await finish(collector, settled);
});

test("cell 车道主桥接受时，成功行点名 via=primary", async () => {
  const calls = { primary: [], injected: [] };
  const ctx = {
    dshBridge: {
      async answerUserQuestion(payload) {
        calls.primary.push(payload);
        return { accepted: true };
      },
    },
    onRuntimeIdle() {},
  };
  const collectors = new Map();
  const activeTurns = new Map();
  const { collector, settled } = startTurn(ctx, collectors, activeTurns, { earlyStop: true });

  collector(ASK("child-3", "ask-3"));
  const { lines, task } = captureConsole(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  await task;

  assert.deepEqual(calls.primary[0], { sessionId: "child-3", askId: "ask-3", cancelled: true });
  assert.ok(
    lines.some(([, t]) => t.includes("unattended ask cancelled") && t.includes("via=primary")),
    "主桥接受时的成功行必须点名 via=primary",
  );
  await finish(collector, settled);
});
