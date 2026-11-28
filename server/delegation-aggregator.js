// ── Delegation aggregator ────────────────────────────────────────────────────
//
// The summary half of agent-delegation-tools: when every task a conversation
// delegated (manual trigger, same initiator session) holds a terminal state,
// inject ONE aggregation turn back into that session — the persona that
// delegated is prompted to summarize the children's outcomes.
//
// Serialization: the injection rides the engine's execution queue (chainTurn),
// so it never overlaps a task execution; inside the turn it additionally waits
// out any live web turn (waitForIdle — the same contract as a scheduled task).
// Restart safety: `aggregated` is persisted on the task records BEFORE the
// summary prompt is delivered, so a restart never injects twice; groups left
// pending by a restart re-arm at load (rearm).

import * as engine from "../task-engine.js";
import * as chatHistory from "../chat-history.js";
import { waitForIdle, collectTurn } from "./cron-runner.js";

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const OUTCOME_EXCERPT = 400;

const TERMINAL = new Set(["done", "failed", "interrupted"]);

let ctxRef = null;
// initiator sessionIds with an injection already chained — the second-to-last
// finisher must not double-arm while the first chain is queued.
const pendingInjection = new Set();

// The grouping key (fix-fanout-aggregation D2). One ignition wave is one group:
// keying on `initiator` alone merged every wave the same session ever fired
// into a single summary, so a second fan-out (or a debate round) talked over
// the first. `initiatorGroup` is stamped per ignition by the fan-out seam;
// legacy rows and the web-lane delegation tool have none and keep the old
// session-scoped grouping.
export function aggregationKey(task) {
  const group = task?.initiatorGroup ?? null;
  if (group) return group;
  return task?.initiator ?? null;
}

function groupFor(key) {
  return engine.allRecords().filter(
    (t) => t.trigger === "manual" && aggregationKey(t) === key && !t.aggregated,
  );
}

// Groups that are fully terminal and still un-injected, keyed by group key.
// Exported for tests: the injection itself needs a live bridge, the decision
// that there IS something to inject does not.
export function readyGroups(records = engine.allRecords()) {
  const byKey = new Map();
  for (const t of records) {
    if (t.trigger !== "manual" || t.aggregated) continue;
    const key = aggregationKey(t);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t);
  }
  const ready = new Map();
  for (const [key, group] of byKey) {
    if (group.every((t) => TERMINAL.has(t.state))) ready.set(key, group);
  }
  return ready;
}

// Engine onFinished subscriber: only terminal manual finishes can empty a group.
function armAggregation(task) {
  if (task.trigger !== "manual") return;
  if (!TERMINAL.has(task.state)) return;
  const key = aggregationKey(task);
  if (!key) return;
  maybeInject(key);
}

function maybeInject(key) {
  if (pendingInjection.has(key)) return;
  const group = groupFor(key);
  if (!group.length) return;
  if (group.some((t) => !TERMINAL.has(t.state))) return;
  pendingInjection.add(key);
  engine.chainTurn(() =>
    runInjection(key).finally(() => pendingInjection.delete(key)),
  );
}

// Last recorded assistant text of a task's dedicated session — the outcome the
// summary is built from. Absent sessions (deleted) degrade to the error gist.
async function outcomeText(task) {
  try {
    const sess = await chatHistory.getSession(task.sessionId);
    const asst = (sess?.messages || []).filter((m) => m.role === "assistant");
    if (asst.length && asst[asst.length - 1].content) {
      return String(asst[asst.length - 1].content).slice(0, OUTCOME_EXCERPT);
    }
  } catch { /* no session yet / deleted */ }
  return null;
}

// Re-anchor the summary's persona onto the initiator session (add-cell-session-
// persona). Two mechanisms by child capability: a preset/set-capable child
// PARKS the initiator persona onto the initiator session — a live session
// already composes it (refusal → nothing to fix), a dormant one would resume
// the runtime default (the last fan-out target's persona), so the park
// re-anchors it before the resume; no restart, and the runtime default stays
// where the fan-out left it (per-session persona world). An older child keeps
// the byte-parity restart switch. Either way a failure degrades open — the
// summary still lands, in whatever persona the session composes. Exported
// for tests.
export async function reanchorInitiatorPersona(ctx, initiator, wanted) {
  if (!wanted || !ctx.currentPreset || ctx.currentPreset === wanted) return;
  const bridge = ctx.dshBridge;
  const canPark =
    !!bridge &&
    typeof bridge.hasLiveMethod === "function" &&
    bridge.hasLiveMethod("preset/set") &&
    typeof bridge.setPreset === "function";
  if (canPark) {
    try {
      if (bridge.preparedPreset?.(initiator) !== wanted) {
        await bridge.setPreset({ sessionId: initiator, presetId: wanted });
      }
    } catch { /* refused (live session already in persona) or park error — summary still lands */ }
  } else if (typeof ctx.switchPresetTo === "function") {
    // idle already waited, and switchPresetTo serializes its own restart.
    try {
      await ctx.switchPresetTo(wanted);
    } catch { /* stayed on the target persona — the summary still lands */ }
  }
}

// ── Ruling turn identity (add-fleet-ruling-ledger) ──────────────────────────
//
// The summary/ruling turn is the one fleet turn that does NOT go through the
// task engine: the aggregator prompts the initiating session directly. That
// made it invisible — no O1 row, no run header, no chain — so a debate could
// not hang the next wave off it, and its cost never counted.
//
// Identity comes from data that already exists:
//   - a JUDGE wave encodes it in the initiator (`fleet:<fleetId>:<judgeId>`);
//   - a no-judge summary runs in the upstream post's session, so the post that
//     ignited the wave is the speaker — the hops carry it as
//     `origin.fleet.byMemberId`.
// Nothing is guessed: no identity → no ledger row (the previous behaviour).
export function rulingTurnIdentity(group, initiator) {
  const m = /^fleet:([^:]+):(.+)$/.exec(String(initiator ?? ""));
  if (m) return { fleetId: m[1], memberId: m[2] };
  const f = group?.[0]?.origin?.fleet ?? null;
  if (f?.fleetId && f?.byMemberId) return { fleetId: f.fleetId, memberId: f.byMemberId };
  return null;
}

// A job-shaped value the ledger can open a turn for. It joins the WAVE's run
// (chain.runId) and sits under its parent turn, which is what makes the ruling
// turn a real node — the precondition for multi-round debate.
export function rulingTurnJob({ group, initiator }) {
  const who = rulingTurnIdentity(group, initiator);
  if (!who) return null;
  const chain = group?.[0]?.origin?.fleet?.chain ?? null;
  return {
    id: `ruling_${Date.now().toString(36)}`,
    trigger: "manual",
    type: "manual",
    targetType: "persona",
    preset: group?.[0]?.initiatorPreset ?? null,
    sessionId: initiator,
    initiator,
    sourceTag: { fleetId: who.fleetId, memberId: who.memberId },
    origin: { fleet: { fleetId: who.fleetId, memberId: who.memberId, ...(chain ? { chain } : {}) } },
  };
}

async function runInjection(key) {
  const ctx = ctxRef;
  if (!ctx?.dshBridge?.isReady()) return;

  // Worker drain (design D4): a just-terminal group may still have sibling
  // executions streaming on workers — wait them out before injecting.
  await ctx.workerPool?.drain?.();

  // Never overlap a live web turn — wait it out like a scheduled task would.
  try {
    await waitForIdle(ctx, IDLE_TIMEOUT_MS);
  } catch {
    return; // the live turn wedged; the group re-arms on the next finish
  }

  const group = groupFor(key);
  if (!group.length) return; // everything deleted meanwhile — nothing to say
  // The group key is an ignition id, not a session: the session the summary
  // lands in comes from the tasks themselves (every task in a group shares it).
  const initiator = group[0].initiator ?? null;
  if (!initiator) return;

  // Persist the aggregated markers BEFORE prompting: a crash between here and
  // the prompt may lose one summary, but never duplicates it.
  for (const t of group) t.aggregated = true;
  await engine.saveTasks();

  // The summary is the initiating persona's voice — re-anchor it (exported
  // for tests). fix-fanout-aggregation D1: a no-judge fan-out used to arrive
  // here with no initiatorPreset at all, so this call was a no-op and the
  // summary was spoken by whatever the runtime last composed (the last fan-out
  // target). The seam now always stamps the upstream post's preset.
  await reanchorInitiatorPersona(ctx, initiator, group[0].initiatorPreset);

  const described = await Promise.all(
    group.map(async (t) => ({ t, outcome: await outcomeText(t) })),
  );

  const lines = described.map(({ t, outcome }) => {
    const head = `- [${t.state}] ${t.preset ?? "角色"} — "${(t.prompt || "").slice(0, 120)}"`;
    if (t.error) return `${head}\n  错误: ${t.error}`;
    if (outcome) return `${head}\n  结果: ${outcome}`;
    return head;
  });
  const text =
    `本会话委派的 ${group.length} 个任务已全部完成。请用你自己的口吻为用户汇总各任务的结果，` +
    `点名每个角色，并明确指出失败或中断的任务：\n${lines.join("\n")}`;

  // The marker block rides the persisted user message — clients style the turn
  // as task-authored (not a user bubble) and reloads keep that fact.
  const marker = {
    kind: "task_summary",
    tasks: group.map((t) => ({ id: t.id, persona: t.preset, state: t.state })),
  };
  const blocks = [marker, { kind: "text", text }];

  // The ruling turn becomes a real node in the wave's run (add-fleet-ruling-
  // ledger): opened BEFORE the prompt (a mid-turn dispatch from the ruling
  // agent can then chain off it) and ended with the outcome (so its tokens and
  // cost count), then the run settles with it included.
  const startedAt = Date.now();
  const rulingJob = rulingTurnJob({ group, initiator });
  let rulingHandle = null;
  if (rulingJob) {
    try {
      rulingHandle = ctx.fleetTurnLedger?.begin?.(rulingJob, { startedAt, sessionIds: [initiator] }) ?? null;
    } catch (e) {
      console.warn(`[fleets] ruling ledger begin failed: ${e?.message || e}`);
    }
  }
  const closeRulingTurn = (outcome) => {
    if (!rulingJob) return;
    try {
      ctx.fleetTurnLedger?.end?.(rulingJob, rulingHandle, outcome, { startedAt, endedAt: Date.now(), model: null });
      if (rulingHandle?.runId) ctx.fleetTurnLedger?.settle?.(rulingHandle.runId, {});
    } catch (e) {
      console.warn(`[fleets] ruling ledger end failed: ${e?.message || e}`);
    }
  };

  const isLive = chatHistory.currentSessionId() === initiator;
  if (isLive) {
    // Mirror the web prompt path: streaming flag, turn attribution, viewer
    // echo, SQLite mirror — then the session shim prompt. Persistence of the
    // assistant reply and the `done` broadcast are dsh-events' (finishTurn).
    const T = ctx.turnStateFor(initiator);
    T.promptStopped = false;
    T.isStreaming = true;
    T.startedAt = Date.now();
    T.origin = { sessionId: initiator, user: null };
    ctx.webTurnSessions.add(initiator);
    ctx.sendToViewers(initiator, { type: "user", text, taskSummary: true });
    chatHistory.recordMessage(initiator, "user", text, blocks);
    try {
      await ctx.session.prompt(text);
      // The live path's usage arrives through dsh-events, not here: record the
      // turn honestly WITHOUT usage rather than inventing numbers.
      closeRulingTurn({ ok: true });
    } catch (e) {
      ctx.finishTurn(undefined, initiator);
      closeRulingTurn({ ok: false, error: e?.message || String(e) });
    }
  } else {
    // The user switched away: collector path (the cron-runner contract) — the
    // summary streams into the initiator session for later reading.
    chatHistory.recordMessage(initiator, "user", text, blocks);
    const collected = collectTurn(ctx, initiator, TURN_TIMEOUT_MS, ctx.taskTurnRegistry ?? new Map());
    try {
      await ctx.dshBridge.prompt(initiator, [{ type: "text", text }]);
      const result = await collected;
      closeRulingTurn({
        ok: !result?.error,
        error: result?.error ?? null,
        usage: result?.usage ?? null,
        text: result?.text ?? null,
      });
    } catch {
      // aborted or failed — the marker is already persisted; the turn is
      // readable next time the session opens.
      //
      // The collector must go WITH it (same three lines cron-runner's own catch
      // uses): `collectTurn` registered this session in `sessionCollectors` and
      // `taskTurnRegistry` with a TURN_TIMEOUT_MS (10 min) timer, and BOTH are
      // inputs to `ctx.runtimeBusy()`. Leaving them behind makes the whole cell
      // look busy for ten minutes after a turn that never started — every
      // deferred restart (MCP patch, credential, catalog-preset roster) is then
      // blocked, and the child keeps serving the stale profile.
      //
      // Measured 2026-11-14 (full fast lane, twice): one failed delegation turn
      // held `collectors=[platform-…] taskTurns=[platform-…]` for the whole
      // window, and focus-overlay:174 spent its 90s roster wait inside it.
      // `settle()` also calls onRuntimeIdle, so the deferred restarts drain the
      // moment this runs.
      try {
        ctx.taskTurnRegistry?.get?.(initiator)?.("delegation turn aborted");
      } catch { /* best-effort settle */ }
      ctx.sessionCollectors?.delete?.(initiator);
      ctx.taskTurnRegistry?.delete?.(initiator);
      ctx.onRuntimeIdle?.();
    }
    void ctx.broadcastSessions?.();
  }
}

// Mount AFTER the engine is initialized (initCron clears hook subscribers):
// registers the finish hook and re-arms groups a restart left pending.
export function attachDelegationAggregator(ctx) {
  ctxRef = ctx;
  engine.addOnFinished(armAggregation);
  return { rearm: () => rearmPending(ctx) };
}

// At load: any initiator whose group is fully terminal injects once (it never
// got its summary); groups with running/queued members wait for their finish
// events. Chained, not inline — boot must not block on a summary.
function rearmPending() {
  const keys = new Set(
    engine
      .allRecords()
      .filter((t) => t.trigger === "manual" && !t.aggregated)
      .map((t) => aggregationKey(t))
      .filter(Boolean),
  );
  for (const key of keys) {
    maybeInject(key);
  }
}
