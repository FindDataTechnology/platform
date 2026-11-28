// Unit tests — turn attribution + lane breaker (fix-fleet-turn-attribution).
//
// Pins:
//   - timeoutError: stalled (a call awaiting its result) vs
//     turn_budget_exceeded (all calls returned, steps ran out) vs the honest
//     empty shape for a turn with no tool history
//   - laneKeyFor: stable, endpoint-sensitive, never leaks key material
//   - the breaker: opens at the streak threshold, closes on any success,
//     honors the kill switch, and IGNORES spacing between failures
//     (fix-llm-breaker-streak — unattended cadences ≥15min/hourly can never
//     fill a fixed wall-clock window; the count is consecutive, not timely)
//   - shapeTurnOutcome: skipped is its own status; detail rides the row
//   - failureStreak: a skipped round stops the streak like any non-failure
//   - runPersonaTurn: one retry on a fast upstream failure with the chain's
//     next candidate (degradedTo recorded); NO retry on timeout; the breaker
//     open window skips the round entirely
//
// Run: node --test scripts/test-fleet-turn-attribution.mjs

import { test, } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-attr-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const chatHistory = await import("../chat-history.js");
const { initDb } = await import("../db.js");
const { attachCronRunner } = await import("../server/cron-runner.js");
const { timeoutError } = await import("../server/cron-runner.js");
const { laneKeyFor, recordUpstreamFailure, recordUpstreamSuccess, breakerState, resetLanes } = await import("../server/llm-lane.js");
const { shapeTurnOutcome } = await import("../server/fleet-events.js");
const fleetsDbMod = await import("../server/routes/fleets-db.js");

await initDb();
await chatHistory.initChatHistory();

// ── timeoutError ─────────────────────────────────────────────────────────────

test("timeoutError: a call awaiting its result reads stalled, with the tool and wait", () => {
  const now = Date.now();
  const blocks = [
    { name: "search", at: now - 60_000, result: "ok" },
    { name: "web_fetch", at: now - 30_000 }, // no result → the hung call
  ];
  const err = timeoutError(blocks, now - 120_000, now);
  assert.equal(err.message, "turn timed out");
  assert.equal(err.detail.kind, "stalled");
  assert.equal(err.detail.steps, 2);
  assert.equal(err.detail.lastTool, "web_fetch");
  assert.ok(err.detail.lastToolWaitedMs >= 29_000 && err.detail.lastToolWaitedMs <= 31_000, `wait ≈30s, got ${err.detail.lastToolWaitedMs}`);
});

test("timeoutError: all calls returned = budget exhausted; no history = honest empty", () => {
  const now = Date.now();
  const done = timeoutError([{ name: "a", at: now - 10, result: "x" }], now - 600_000, now);
  assert.equal(done.detail.kind, "turn_budget_exceeded");
  assert.equal(done.detail.steps, 1);

  const empty = timeoutError([], now - 600_000, now);
  assert.equal(empty.detail.kind, "turn_budget_exceeded");
  assert.equal(empty.detail.steps, 0);
  assert.equal(empty.detail.lastTool, null, "no invented tool name");
});

// ── laneKeyFor ───────────────────────────────────────────────────────────────

test("laneKeyFor: stable, endpoint-sensitive, key material never appears", () => {
  const secret = "sk-super-secret-key-material-9876";
  const a = laneKeyFor({ id: "volces", baseURL: "http://127.0.0.1:32080/v1", apiKey: secret });
  const b = laneKeyFor({ id: "volces", baseURL: "http://127.0.0.1:32080/v1", apiKey: secret });
  assert.equal(a, b, "same provider → same lane id");
  assert.ok(a.startsWith("lane-"));
  assert.equal(a.length, "lane-".length + 16);
  assert.ok(!a.includes(secret) && !a.includes("32080"), "fingerprint only — no key, no url in the id");
  const other = laneKeyFor({ id: "volces", baseURL: "https://other.example/v1", apiKey: secret });
  assert.notEqual(a, other, "a different endpoint is a different lane");
  const rotated = laneKeyFor({ id: "volces", baseURL: "http://127.0.0.1:32080/v1", apiKey: "sk-new" });
  assert.notEqual(a, rotated, "key rotation re-keys the lane (documented, self-heals)");
});

// ── breaker ──────────────────────────────────────────────────────────────────

test("breaker: opens at the streak threshold, stays open inside the cool-off, closes on success", () => {
  resetLanes();
  const prev = { ...process.env };
  process.env.PLATFORM_LLM_BREAKER_THRESHOLD = "3";
  process.env.PLATFORM_LLM_BREAKER_OPEN_MS = "60000";
  try {
    const lane = "lane-test";
    const t0 = Date.now();
    let s = recordUpstreamFailure(lane, t0);
    assert.equal(s.open, false, "1/3 — closed");
    s = recordUpstreamFailure(lane, t0 + 1000);
    assert.equal(s.open, false, "2/3 — closed");
    s = recordUpstreamFailure(lane, t0 + 2000);
    assert.equal(s.open, true, "3/3 — open");
    assert.ok(breakerState(lane, t0 + 3000).open, "still open inside the cool-off");

    // Outside the cool-off (last failure t0+2s + 60s open): closed again.
    assert.equal(breakerState(lane, t0 + 63_000).open, false, "cool-off elapsed → closed");

    // A success at any point closes immediately.
    recordUpstreamFailure(lane, t0 + 62_000);
    recordUpstreamSuccess(lane);
    assert.equal(breakerState(lane).open, false);
    assert.equal(breakerState(lane).streak, 0);
  } finally {
    for (const k of ["PLATFORM_LLM_BREAKER_THRESHOLD", "PLATFORM_LLM_BREAKER_OPEN_MS"]) delete process.env[k];
    void prev;
  }
});

test("breaker: spacing is irrelevant — a streak across hours opens at the threshold (fix-llm-breaker-streak)", () => {
  // The red→green heart: a 5-in-10-min sliding window (the old implementation)
  // can NEVER open against hourly-unattended pacing — each failure sweeps its
  // predecessors away. The streak does not care about spacing.
  resetLanes();
  const prev = { ...process.env };
  process.env.PLATFORM_LLM_BREAKER_THRESHOLD = "5";
  process.env.PLATFORM_LLM_BREAKER_OPEN_MS = "7200000"; // 2h default cool-off
  try {
    const lane = "lane-hours";
    const t0 = Date.now();
    const HOUR = 3600_000;
    for (let i = 0; i < 4; i++) {
      const s = recordUpstreamFailure(lane, t0 + i * 3 * HOUR);
      assert.equal(s.open, false, `failure ${i + 1}/5 across 3h spacing — closed`);
    }
    const opened = recordUpstreamFailure(lane, t0 + 4 * 3 * HOUR);
    assert.equal(opened.open, true, "the 5th consecutive failure opens regardless of spacing");
    assert.equal(opened.streak, 5);

    // Half-open probe: the first real round AFTER the cool-off fails — the
    // streak is still above the threshold, so the cool-off rolls forward.
    const probe = t0 + 4 * 3 * HOUR + 3 * HOUR; // one round past openUntil
    const re = recordUpstreamFailure(lane, probe);
    assert.ok(re.open, "probe failure reopens without requoting the threshold");
    assert.ok(re.openUntil > probe, "openUntil rolled past the probe");

    // Success clears everything — the single probe that lands on a healthy
    // lane closes the breaker and resets the count.
    recordUpstreamSuccess(lane);
    assert.equal(breakerState(lane).open, false);
    assert.equal(breakerState(lane).streak, 0);
    const afterReset = recordUpstreamFailure(lane, probe + HOUR);
    assert.equal(afterReset.open, false, "post-reset a lone failure does not open");
  } finally {
    for (const k of ["PLATFORM_LLM_BREAKER_THRESHOLD", "PLATFORM_LLM_BREAKER_OPEN_MS"]) delete process.env[k];
    void prev;
  }
});

test("breaker: the kill switch keeps every lane closed", () => {
  resetLanes();
  process.env.PLATFORM_LLM_BREAKER = "0";
  try {
    for (let i = 0; i < 10; i++) recordUpstreamFailure("lane-x", Date.now());
    assert.equal(breakerState("lane-x").open, false);
    assert.equal(breakerState("lane-x").enabled, false);
  } finally {
    delete process.env.PLATFORM_LLM_BREAKER;
  }
});

test("runPersonaTurn: a fleet post with no model plan fails instead of reporting ok", async () => {
  // Ledger E28 (live 2026-11-09): the catalog fetch was failing, resolveFleetModel
  // returned null, normalizeModelForJob took its "not a fleet post" door and
  // answered {ok:true} — the round settled status=ok with model=null, no usage
  // and no trace, i.e. a success that never ran. A job that carries fleet
  // attribution must not use that door.
  const prompts = [];
  const ctx = attrCtx({ prompts });
  ctx.resolveFleetModel = () => null; // catalog/model roster unreachable
  const { runPersonaTurn } = await import("../server/cron-runner.js");
  const out = await runPersonaTurn(ctx, fleetJob(), 5_000, new Map(), { startedAt: Date.now() });
  assert.equal(out.ok, false);
  assert.match(String(out.error), /model resolution unavailable/);
  assert.equal(prompts.length, 0, "never prompted on an unspecified model");
});

// ── shapeTurnOutcome: skipped + detail ───────────────────────────────────────

test("shapeTurnOutcome: skipped is its own status, errorKind null, detail rides", () => {
  const out = shapeTurnOutcome({ ok: false, skipped: true, error: "llm lane lane-abc open" });
  assert.equal(out.status, "skipped");
  assert.equal(out.errorKind, null);

  const failed = shapeTurnOutcome({ ok: false, error: "403 status code (no body)", detail: { kind: "stalled", steps: 2, lastTool: "web_fetch", lastToolWaitedMs: 900 } });
  assert.equal(failed.status, "failed");
  assert.equal(failed.detail.kind, "stalled");
  assert.equal(failed.detail.lastTool, "web_fetch");

  const ok = shapeTurnOutcome({ ok: true, detail: { degradedTo: "model-b" } });
  assert.equal(ok.status, "ok");
  assert.equal(ok.detail.degradedTo, "model-b");

  assert.equal(shapeTurnOutcome({ ok: true }).detail, null, "no detail → honest null");
});

// ── shapeTurnOutcome: 空壳 ok 不算成功 ───────────────────────────────────────

test("shapeTurnOutcome: an explicitly hollow ok settles as interrupted", () => {
  // harden-fleet-tool-face-and-queue 3.5 / ledger E21's third shape. Live
  // 2026-11-09: three rounds came back status=ok with model=null,
  // traceTurnId=null, no usage and no new report — a restart mid-turn, the
  // executor's success path returning an empty {ok:true}. The signal is
  // EXPLICIT (`hollow`) because `no usage` alone has its own contract
  // (context-budget: no basis → no verdict → status stays ok).
  const hollow = shapeTurnOutcome({ ok: true, hollow: true });
  assert.equal(hollow.status, "interrupted", "空壳不能记成功");
  assert.match(String(hollow.error), /no usage and no attribution/);
  assert.equal(hollow.usage, null);

  // Usage alone does NOT rescue it once the stub shape also matches: upstream
  // added a stub-turn guard (fix-stub-turn-success) whose precedence is above
  // hollow — tiny output + no text + no tool call + no report is a stub
  // regardless of hollow. A round with real WORK rescues via text/toolBlocks.
  const withUsage = shapeTurnOutcome({ ok: true, hollow: true, usage: { input: 12, output: 3 } });
  assert.equal(withUsage.status, "interrupted", "3 个输出 token 且无任何产出 = stub，仍不是成功");
  const withRealWork = shapeTurnOutcome({ ok: true, hollow: true, usage: { input: 12, output: 900 }, text: "done", toolBlocks: [{ id: "t1" }] });
  assert.equal(withRealWork.status, "ok", "有真实产出的回合是成功");
  const withoutSignal = shapeTurnOutcome({ ok: true });
  assert.equal(withoutSignal.status, "ok", "无显式空壳信号时维持既有契约");
  const withAttribution = shapeTurnOutcome({ ok: true, hollow: true }, { hasAttribution: true });
  assert.equal(withAttribution.status, "ok");

  // A real failure is untouched by this guard.
  assert.equal(shapeTurnOutcome({ ok: false, error: "502 upstream" }).status, "failed");
});

// ── failureStreak ignores skipped ────────────────────────────────────────────

test("failureStreak: a skipped round is transparent (neither counts nor breaks the run)", async () => {
  const { createFleetDatabase, setFleetDatabase } = fleetsDbMod;
  const db = createFleetDatabase({ file: path.join(tmpRoot, `fleets-${Date.now()}.db`) });
  setFleetDatabase(db);
  const fleet = db.createFleet({ id: `fleet_${Math.random().toString(36).slice(2, 8)}`, name: "归因舰队", ownerEmail: "owner@test" });
  const member = db.createMember({
    id: `m_${Math.random().toString(36).slice(2, 8)}`,
    fleetId: fleet.id,
    title: "投稿岗",
    parentId: null,
    targetKind: "persona",
    targetId: "persona-a",
    kpiSlots: [],
    cadence: { cron: "0 * * * *", tz: null, promptTemplate: "报数", enabled: true },
  });

  const base = Date.now() - 100_000;
  db.appendTurnEvent({ fleetId: fleet.id, memberId: member.id, source: "cron", status: "failed", errorKind: "model_upstream", startedAt: base, endedAt: base + 100 });
  db.appendTurnEvent({ fleetId: fleet.id, memberId: member.id, source: "cron", status: "skipped", startedAt: base + 200, endedAt: base + 201 });
  db.appendTurnEvent({ fleetId: fleet.id, memberId: member.id, source: "cron", status: "failed", errorKind: "model_upstream", startedAt: base + 300, endedAt: base + 400 });

  // The walk SKIPS OVER skipped rows (fix-fleet-turn-veracity D4, transparent
  // crossing): the post's two REAL failures stay visible across the platform's
  // skip instead of the skip "healing" the streak.
  assert.equal(db.failureStreak(member.id).streak, 2, "skipped is transparent — real failures stay counted");
  const last = db.latestTurnFor(member.id);
  assert.equal(last.status, "failed");
  assert.equal(last.detail, null, "pre-attribution rows read honest absence");
});

// ── runPersonaTurn: retry + breaker skip through the real seam ───────────────

const fleetJob = (over = {}) => ({
  id: "job_a1",
  sessionId: "cron-attr",
  prompt: "巡视",
  preset: "persona-a",
  targetType: "persona",
  sourceTag: { fleetId: "fleet-1", memberId: "m-1" },
  ...over,
});

function attrCtx({ prompts = [] } = {}) {
  const ctx = {
    currentPreset: "persona-a",
    isStreaming: false,
    sessionCollectors: new Map(),
    sessionVersion: 1,
    broadcast: () => {},
    onRuntimeIdle: () => {},
    reserveRuntime: () => () => {},
    switchPresetTo: async () => ({ ok: true }),
    switchModelTo: async (id) => {
      ctx.switches.push(id);
      ctx.session = { model: { id } };
      return { ok: true };
    },
    switches: [],
    // The salvage lane's follow-up is a DIFFERENT thing from an attempt: it does
    // not walk the model chain, it asks the same child for the report it never
    // filed. Both ride `dshBridge.prompt`, so the fixture has to tell them apart
    // or "a timeout does not retry" stops meaning anything
    // (fix-turn-budget-soft-stop).
    wrapUps: [],
    prompts,
    resolveFleetModel: () => ({
      memberId: "m-1",
      candidates: [{ model: "model-a" }, { model: "model-b" }],
      notices: [],
    }),
    recordFleetModelNotices: () => {},
    llmLaneForModel: (modelId) => (modelId ? `lane-for-${modelId}` : null),
    dshBridge: {
      isReady: () => true,
      prompt: async (sessionId, blocks = []) => {
        const text = Array.isArray(blocks) ? blocks.map((b) => b?.text ?? "").join("") : "";
        if (/report_status/.test(text)) {
          // The wrap-up: hand the collector an idle so the salvage lane settles.
          ctx.wrapUps.push(sessionId);
          ctx.sessionCollectors.get(sessionId)?.({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "补交：已交报数" }] } } } } });
          ctx.sessionCollectors.get(sessionId)?.({ method: "session.status", params: { status: "idle" } });
          return;
        }
        ctx.prompts.push(sessionId);
        const behavior = ctx.promptBehavior(ctx.prompts.length);
        if (behavior === "upstream") throw new Error("502 upstream service temporarily unavailable");
        if (behavior === "hang") return; // prompt returns; the runtime never finishes → collectTurn's timer rejects
        if (behavior === "hangWithTool") {
          // starts a tool call and never returns a result — the stalled shape
          ctx.sessionCollectors.get(sessionId)?.({
            method: "session.event",
            params: { event: { type: "tool/call", data: { callId: "t1", name: "web_fetch", arguments: "{}" } } },
          });
          return;
        }
        const collector = ctx.sessionCollectors.get(sessionId);
        collector?.({ method: "session.status", params: { status: "idle" } });
      },
    },
    promptBehavior: () => "ok",
  };
  attachCronRunner(ctx);
  return ctx;
}

test("runPersonaTurn: a fast upstream failure retries ONCE on the next candidate and records degradedTo", async () => {
  resetLanes();
  const ctx = attrCtx();
  ctx.promptBehavior = (n) => (n === 1 ? "upstream" : "ok");

  const out = await ctx.runCronJobTurn(fleetJob(), { turnTimeoutMs: 800 });
  assert.equal(out.ok, true, "the retry landed");
  assert.deepEqual(ctx.switches, ["model-a", "model-b"], "walked to the next candidate");
  assert.equal(out.detail?.degradedTo, "model-b");
});

test("runPersonaTurn: a SLOW upstream failure with zero output still retries once (2026-11-11)", async () => {
  resetLanes();
  const ctx = attrCtx();
  // 把一个「跑了很久、什么都没产出」的上游失败造出来：把快速窗口压到 1ms，
  // 于是 shouldRetryFastFailure 物理上不可能命中（elapsed >= 1ms 必然成立）。
  // 这条正是现场那 42/54 的形状：5xx 在 1 分钟之后才回来，快速门永远不开。
  process.env.PLATFORM_LLM_RETRY_FAST_MS = "1";
  try {
    // 让上游失败**真的**慢过窗口：不加这段，elapsed≈0ms 仍然 <1ms，
    // 快速门照样先命中，等于没测到归零门（第一版就是这么假绿的）。
    const inner = ctx.dshBridge.prompt;
    ctx.dshBridge.prompt = async (sessionId) => {
      await new Promise((r) => setTimeout(r, 25));
      return inner(sessionId);
    };
    ctx.promptBehavior = (n) => (n === 1 ? "upstream" : "ok");
    const out = await ctx.runCronJobTurn(fleetJob({ id: "job_zero", sessionId: "cron-attr-zero" }), { turnTimeoutMs: 800 });
    assert.equal(out.ok, true, "零产出的一次性损失值得再试一次");
    assert.deepEqual(ctx.switches, ["model-a", "model-b"], "换到链上的下一跳");
    assert.equal(out.detail?.degradedTo, "model-b");
    assert.equal(out.detail?.retryReason, "zero_output", "要写清是哪个门放行的那一次重试");
  } finally {
    delete process.env.PLATFORM_LLM_RETRY_FAST_MS;
  }
});

test("runPersonaTurn: FLEET_RETRY_ZERO_OUTPUT=0 关掉这道门（回滚闸）", async () => {
  resetLanes();
  const ctx = attrCtx();
  process.env.PLATFORM_LLM_RETRY_FAST_MS = "1";
  process.env.FLEET_RETRY_ZERO_OUTPUT = "0";
  try {
    const inner = ctx.dshBridge.prompt;
    ctx.dshBridge.prompt = async (sessionId) => {
      await new Promise((r) => setTimeout(r, 25));
      return inner(sessionId);
    };
    ctx.promptBehavior = (n) => (n === 1 ? "upstream" : "ok");
    const out = await ctx.runCronJobTurn(fleetJob({ id: "job_zero_off", sessionId: "cron-attr-zero-off" }), { turnTimeoutMs: 800 });
    assert.equal(out.ok, false, "关了门就不该重试");
    assert.equal(ctx.prompts.length, 1, "只跑一次");
  } finally {
    delete process.env.PLATFORM_LLM_RETRY_FAST_MS;
    delete process.env.FLEET_RETRY_ZERO_OUTPUT;
  }
});

test("runPersonaTurn: a timeout does NOT retry (the work's own shape, not the lane's)", async () => {
  resetLanes();
  const ctx = attrCtx();
  // The runtime starts a tool call and never finishes it — the stalled shape.
  ctx.promptBehavior = (n) => (n === 1 ? "hangWithTool" : "ok");

  const out = await ctx.runCronJobTurn(fleetJob({ id: "job_a2", sessionId: "cron-attr2" }), { turnTimeoutMs: 60 });
  assert.equal(out.ok, false);
  assert.equal(ctx.prompts.length, 1, "exactly one attempt — timeouts never retry");
  // 2026-11-13 (fix-turn-budget-soft-stop): a fleet round that stops on budget
  // (this 60ms round soft-stops at 48ms) gets ONE bounded follow-up asking for
  // the report. That is the salvage lane, not a second attempt — `prompts` stays
  // at 1 above, so a retry would still fail this test.
  assert.equal(ctx.wrapUps.length, 1, "the lane asks once for the report it never filed");
  // Fleet rounds rotate the child session id, so "same session" means the one
  // the attempt actually prompted — not the mirror row id.
  assert.equal(ctx.wrapUps[0], ctx.prompts[0], "and asks the SAME child session — the one that did the work");
  assert.equal(out.detail?.kind, "stalled", "the failure carries its attribution");
  assert.equal(out.detail?.lastTool, "web_fetch");
  // Two honest settlements exist for a fleet round that did not finish, and both
  // must say WHY: the wall ("turn timed out") and the budget soft stop
  // (fix-turn-budget-soft-stop — this 60ms round stops at 48ms). What this test
  // guards is that the round was NOT retried, asserted by `prompts.length` above.
  assert.match(out.error, /turn (timed out|stopped early — budget soft stop)/);
  assert.equal(out.detail?.budgetSoftStop, true, "a sub-second budget lands on the soft stop, not the wall");
});

test("runPersonaTurn: an open lane skips the round — no prompt, skipped outcome", async () => {
  resetLanes();
  const ctx = attrCtx();
  const lane = ctx.llmLaneForModel("model-a");
  for (let i = 0; i < 10; i++) recordUpstreamFailure(lane, Date.now());
  assert.ok(breakerState(lane).open, "precondition: the lane is open");

  const out = await ctx.runCronJobTurn(fleetJob({ id: "job_a3", sessionId: "cron-attr3" }), { turnTimeoutMs: 5000 });
  assert.equal(out.skipped, true);
  assert.equal(ctx.prompts.length, 0, "nothing dispatched into an open lane");
  assert.match(out.error, /open until/);

  recordUpstreamSuccess(lane);
  const after = await ctx.runCronJobTurn(fleetJob({ id: "job_a4", sessionId: "cron-attr4" }), { turnTimeoutMs: 5000 });
  assert.equal(after.skipped, undefined, "success closed the breaker; the next round runs");
});

test("runCronJobTurn records upstream failures against the turn's lane at the seam", async () => {
  resetLanes();
  const ctx = attrCtx();
  ctx.promptBehavior = () => "upstream";
  // No candidates beyond the landed one → no retry → the failure reaches the seam.
  ctx.resolveFleetModel = () => ({ memberId: "m-1", candidates: [{ model: "model-a" }], notices: [] });

  const out = await ctx.runCronJobTurn(fleetJob({ id: "job_a5", sessionId: "cron-attr5" }), { turnTimeoutMs: 5000 });
  assert.equal(out.ok, false);
  const lane = ctx.llmLaneForModel("model-a");
  assert.ok(breakerState(lane).streak >= 1, "the seam fed the breaker");

  ctx.promptBehavior = () => "ok";
  await ctx.runCronJobTurn(fleetJob({ id: "job_a6", sessionId: "cron-attr6" }), { turnTimeoutMs: 5000 });
  assert.equal(breakerState(lane).streak, 0, "success closed it");
});

// fix-degrade-mark-on-failed-retry（2026-11-12）：重试**仍败**时的徽记。
// 现网实测 13/13 条零产出上游失败行 detail=null —— 盖章分支只在
// （重试成功）或（原本已有 detail）时执行；两次都败且原本为空时徽记凭空消失，
// 于是「降级重试发生过」在任何台账上都不可判。spec 既有条款要求
// 「降级重试 SHALL 在 detail 记 degradedTo」，这是实现与契约不符。
test("runPersonaTurn: a retry that fails AGAIN still records degradedTo/retryReason (2026-11-12)", async () => {
  resetLanes();
  const ctx = attrCtx();
  process.env.PLATFORM_LLM_RETRY_FAST_MS = "1";
  try {
    // 同上一条：快速窗口压到 1ms + 每次上游失败都慢过 1ms，确保走零产出门而非快速门。
    const inner = ctx.dshBridge.prompt;
    ctx.dshBridge.prompt = async (sessionId) => {
      await new Promise((r) => setTimeout(r, 25));
      return inner(sessionId);
    };
    ctx.promptBehavior = () => "upstream"; // 首跳与重试跳**都**失败
    const out = await ctx.runCronJobTurn(fleetJob({ id: "job_zero_fail", sessionId: "cron-attr-zero-fail" }), { turnTimeoutMs: 800 });
    assert.equal(out.ok, false, "重试仍败，结局仍是失败（不得因重试过就改判成功）");
    // 先钉住「重试真的发生过」：否则将来这条会因为「压根没重试」而假绿。
    assert.ok(ctx.switches.includes("model-b"), `降级必须真的走过下一跳，实际 switches=${JSON.stringify(ctx.switches)}`);
    assert.equal(out.detail?.degradedTo, "model-b", "重试发生过，就必须留下降级到的档位");
    assert.equal(out.detail?.retryReason, "zero_output", "并写清是哪道门放行的这次重试");
  } finally {
    delete process.env.PLATFORM_LLM_RETRY_FAST_MS;
  }
});
