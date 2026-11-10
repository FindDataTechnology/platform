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
      prompt: async (sessionId) => {
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

test("runPersonaTurn: a timeout does NOT retry (the work's own shape, not the lane's)", async () => {
  resetLanes();
  const ctx = attrCtx();
  // The runtime starts a tool call and never finishes it — the stalled shape.
  ctx.promptBehavior = (n) => (n === 1 ? "hangWithTool" : "ok");

  const out = await ctx.runCronJobTurn(fleetJob({ id: "job_a2", sessionId: "cron-attr2" }), { turnTimeoutMs: 60 });
  assert.equal(out.ok, false);
  assert.equal(ctx.prompts.length, 1, "exactly one attempt — timeouts never retry");
  assert.equal(out.detail?.kind, "stalled", "the timeout carries its attribution");
  assert.equal(out.detail?.lastTool, "web_fetch");
  assert.match(out.error, /turn timed out/);
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
