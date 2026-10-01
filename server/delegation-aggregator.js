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

function groupFor(initiator) {
  return engine.allRecords().filter(
    (t) => t.trigger === "manual" && t.initiator === initiator && !t.aggregated,
  );
}

// Engine onFinished subscriber: only terminal manual finishes can empty a group.
function armAggregation(task) {
  if (task.trigger !== "manual" || !task.initiator) return;
  if (!TERMINAL.has(task.state)) return;
  maybeInject(task.initiator);
}

function maybeInject(initiator) {
  if (pendingInjection.has(initiator)) return;
  const group = groupFor(initiator);
  if (!group.length) return;
  if (group.some((t) => !TERMINAL.has(t.state))) return;
  pendingInjection.add(initiator);
  engine.chainTurn(() =>
    runInjection(initiator).finally(() => pendingInjection.delete(initiator)),
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

async function runInjection(initiator) {
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

  const group = groupFor(initiator);
  if (!group.length) return; // everything deleted meanwhile — nothing to say

  // Persist the aggregated markers BEFORE prompting: a crash between here and
  // the prompt may lose one summary, but never duplicates it.
  for (const t of group) t.aggregated = true;
  await engine.saveTasks();

  // The fan-out leaves the runtime on the last TARGET persona; the summary is
  // the initiating persona's voice — switch back first (idle already waited,
  // and switchPresetTo serializes its own restart).
  const wanted = group[0].initiatorPreset;
  if (wanted && ctx.currentPreset && ctx.currentPreset !== wanted && typeof ctx.switchPresetTo === "function") {
    try {
      await ctx.switchPresetTo(wanted);
    } catch { /* stayed on the target persona — the summary still lands */ }
  }

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

  const isLive = chatHistory.currentSessionId() === initiator;
  if (isLive) {
    // Mirror the web prompt path: streaming flag, turn attribution, viewer
    // echo, SQLite mirror — then the session shim prompt. Persistence of the
    // assistant reply and the `done` broadcast are dsh-events' (finishTurn).
    ctx.promptStoppedByNavigation = false;
    ctx.isStreaming = true;
    ctx.turnOrigin = { sessionId: initiator, user: null };
    ctx.sendToViewers(initiator, { type: "user", text, taskSummary: true });
    chatHistory.recordMessage(initiator, "user", text, blocks);
    try {
      await ctx.session.prompt(text);
    } catch {
      ctx.finishTurn();
    }
  } else {
    // The user switched away: collector path (the cron-runner contract) — the
    // summary streams into the initiator session for later reading.
    chatHistory.recordMessage(initiator, "user", text, blocks);
    const collected = collectTurn(ctx, initiator, TURN_TIMEOUT_MS, ctx.taskTurnRegistry ?? new Map());
    try {
      await ctx.dshBridge.prompt(initiator, [{ type: "text", text }]);
      await collected;
    } catch {
      // aborted or failed — the marker is already persisted; the turn is
      // readable next time the session opens
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
  const initiators = new Set(
    engine
      .allRecords()
      .filter((t) => t.trigger === "manual" && t.initiator && !t.aggregated)
      .map((t) => t.initiator),
  );
  for (const initiator of initiators) {
    maybeInject(initiator);
  }
}
