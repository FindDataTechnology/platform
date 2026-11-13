// Cron turn executor: the host half of the cron engine (cron.js owns timers,
// persistence and history; this module owns what "run the job" means on a
// live cell). One invocation = one agent turn in the job's bound session:
//
//   wait for idle → switch the runtime to the job's preset → create/record
//   the bound session → prompt it under a session collector → persist the
//   exchange → refresh the sessions broadcast.
//
// The collector pattern is the bot-relay one (server/bots.js collectTurn):
// notifications for a session other than the live one are routed to its
// registered collector and never hit the web broadcast path — that is what
// keeps a scheduled turn out of the user's open transcript while still
// recording it under the job's session for later reading.

import * as chatHistory from "../chat-history.js";
import * as catalog from "../catalog.js";
import * as dshProfile from "../dsh-profile.js";
import { parseToolResult } from "./dsh-events.js";
import { getClusterDatabase } from "./routes/clusters-db.js";
import { runA2aTurn, resolveGatewayCredential } from "./a2a-client.js";
import { clusterMemoryFor, memoryInjectionFor } from "@finddatatechnology/yongyi-client";
import { runToolTurn as runToolTurnDefault } from "./tool-turn.js";
import { classifyErrorKind, normalizeUsage } from "./fleet-events.js";
import { breakerState, recordUpstreamFailure, recordUpstreamSuccess } from "./llm-lane.js";
import { classifyPresetSetError } from "../dsh-bridge.js";
import { getFleetDatabase } from "./routes/fleets-db.js";
import { turnTokens } from "./model-budget.js";
import { retryFastWindowMs, shouldRetryFastFailure, shouldDegradeOverBudget } from "./cron-decisions.js";

// ── Turn carrier (add-fleet-carrier) ─────────────────────────────────────────
//
// The placement dimension, resolved per turn: member.carrier → fleet
// constraints.carrier → CELL_CARRIER_DEFAULT → "auto". Two small sqlite reads
// (local db, µs) — no cache to drift. Exported for tests (the db is injectable).
export function resolveTaskCarrier(job, { db = null } = {}) {
  const wanted = String(job?.carrier ?? "").trim();
  if (wanted === "cell" || wanted === "worker" || wanted === "runner") return wanted;
  const fleetId = job?.sourceTag?.fleetId ?? null;
  if (fleetId) {
    try {
      const fdb = db ?? getFleetDatabase();
      // member layer (the live row — covers the reconcile drift window where
      // the task still carries the old materialized value)
      const member = fdb?.getMember?.(job?.sourceTag?.memberId);
      if (["cell", "worker", "runner"].includes(member?.carrier)) return member.carrier;
      const fleet = fdb?.getFleet?.(fleetId);
      const fc = fleet?.orchestration?.constraints?.carrier;
      if (fc === "cell" || fc === "worker" || fc === "runner") return fc;
    } catch { /* degrade to auto */ }
  }
  const envDefault = String(process.env.CELL_CARRIER_DEFAULT ?? "").trim();
  if (envDefault === "cell" || envDefault === "worker" || envDefault === "runner") return envDefault;
  return "auto";
}

// The runner route (add-fleet-carrier D2; matching REWRITTEN by
// add-runner-route-key-match): a runner-deployed persona appears in the
// catalog as an a2a entry whose DEPLOYED AGENT KEY matches the task's persona
// roster key — the agent key is the registry path's last segment
// (/packs/<packId>/<agentKey>), the same namespace member personas are keyed
// in. Matching by entry id CANNOT work: the registry bridge always prefixes
// catalog ids with "registry-" (mapAgent), so an id never equals a bare
// roster key (活体取证 2026-11-01: chat∩a2a same-id = empty over all 84
// catalog agents). Not found OR ambiguous (≥2 entries sharing the agent key
// across packs — e.g. "reception" ×3) → null; the caller fails open to the
// primary chain with the recorded reason (runner-no-entry / runner-ambiguous).
export function runnerEntryFor(job, { listAgents = null, rosterPresetId = null, packId = null } = {}) {
  if (!job?.preset) return null;
  const agents = (listAgents ?? catalog.listAgents)();
  const roster = rosterPresetId ?? dshProfile.rosterPresetId;
  // The catalog entry carries the route only inside its url
  // ({REGISTRY_URL}/agent{path}/); a raw path field wins when present.
  const agentPathOf = (a) => {
    if (typeof a?.path === "string" && a.path.trim()) return a.path;
    if (typeof a?.url !== "string") return null;
    const m = a.url.match(/\/agent(\/[^?#]*)\/?$/);
    return m ? m[1] : null;
  };
  const agentKeyOf = (a) => {
    const segs = (agentPathOf(a) ?? "").split("/").filter(Boolean);
    const key = segs[segs.length - 1] ?? "";
    return key ? roster(key) : null;
  };
  let hits = agents.filter((a) => a?.mode === "a2a" && agentKeyOf(a) === job.preset);
  // Cross-pack disambiguation (add-runner-packid-disambiguation): a member
  // that declares packId pins the hit to that pack's deployment — the path
  // segment /packs/<packId>/ decides. Without it, ambiguity fails open.
  if (hits.length > 1 && packId) {
    const pinned = hits.filter((a) => (agentPathOf(a) ?? "").includes(`/packs/${packId}/`));
    if (pinned.length === 1) return pinned[0];
    if (pinned.length > 1) hits = pinned; // still ambiguous within the pack → fail open below
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    console.warn(`[fleets] carrier runner for ${job.id}: ${hits.length} a2a entries share the agent key '${job.preset}' (${hits.map((h) => agentPathOf(h) ?? h.id).join(", ")}) — failing open (runner-ambiguous)`);
    job.carrierFallback = "runner-ambiguous";
  }
  return null;
}

const IDLE_POLL_MS = 250;

// Per-post turn budget (fix-fleet-chain-operability D3): member
// cadence.turnTimeoutMs, clamped to [2min, 30min] — the floor keeps a
// mistyped 0/negative from turning a round into an instant kill, the ceiling
// bounds how long one post can hold the shared child (the credential-delivery
// hard cap keys off the longest single-round budget). Unset/invalid/unreadable
// → the historical 10-minute default, byte-for-byte unchanged behavior.
// Fleet-member rounds only; plain cron tasks never read this.
//
// fix-fleet-turn-budget D2: there are TWO declared sources and one precedence —
// the per-edge budget (constraints.budgetPerEdgeMin, stamped by the orchestrator
// onto each dispatch/handoff/fanout hop as executionPolicy.timeoutMinutes) beats
// the per-post one, because the owner's explicit statement about THIS hop is more
// specific than a post's standing default. Both clamp to the same [2min, 30min];
// an invalid edge value falls through to the post rather than to the default.
// Taking the MIN of the two was rejected: it would make raising an edge budget
// silently ineffective.
const TURN_BUDGET_FLOOR_MS = 2 * 60 * 1000;
const TURN_BUDGET_CEILING_MS = 30 * 60 * 1000;
const TURN_BUDGET_DEFAULT_MS = 10 * 60 * 1000;

const clampBudgetMs = (ms) => Math.min(Math.max(ms, TURN_BUDGET_FLOOR_MS), TURN_BUDGET_CEILING_MS);

export function resolveTurnBudgetMs(job, { db = null } = {}) {
  const edgeMs = Number(job?.executionPolicy?.timeoutMinutes) * 60_000;
  if (Number.isFinite(edgeMs) && edgeMs > 0) return clampBudgetMs(edgeMs);

  const fleetId = job?.sourceTag?.fleetId ?? null;
  const memberId = job?.sourceTag?.memberId ?? null;
  if (!fleetId || !memberId) return TURN_BUDGET_DEFAULT_MS;
  try {
    const fdb = db ?? getFleetDatabase();
    const member = fdb?.getMember?.(memberId);
    const declared = member?.cadence?.turnTimeoutMs;
    const n = Number(declared);
    if (!Number.isFinite(n) || n <= 0) return TURN_BUDGET_DEFAULT_MS;
    return clampBudgetMs(n);
  } catch {
    return TURN_BUDGET_DEFAULT_MS;
  }
}
// Monotonic round sequence (unique rotated child ids even within one ms).
let roundSeqCounter = 0;
const PRESET_SWITCH_ATTEMPTS = 3;
// Fleet rounds wait this long for a cold cell's dsh child to finish booting
// (2026-10-25 live: a daily patrol fired 17s after platform start and failed
// `runtime_not_ready`; nothing retried, so that day's patrol was simply lost).
const RUNTIME_READY_WAIT_MS = 120_000;
// Deployment override (fix-fleet-turn-veracity design: grey-rollback valve).
// `FLEET_TURN_READY_WAIT_MS=0` restores the pre-e3396 immediate refusal.
function readyWaitMs() {
  const n = Number(process.env.FLEET_TURN_READY_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : RUNTIME_READY_WAIT_MS;
}
const RUNTIME_READY_POLL_MS = 1_000;
// Context pressure (fix-fleet-turn-budget): two compactions inside one turn is
// already a round that will not finish — the counted evidence is 15–49s gaps
// per compaction and 22 of 28 timed-out rounds landing no report at all. The
// threshold is a diagnosis boundary, not a kill switch: crossing it changes how
// the outcome is NAMED (and lets the wrap-up lane help), never when the turn
// stops.
const CONTEXT_PRESSURE_COMPACTIONS = 2;
// Early stop (fix-fleet-output-salvage D5): naming a storm is not enough when
// the round will not finish anyway. Live 2026-11-09 measurements:
//   • the rounds that die at the budget had 12-15 compactions;
//   • a round with FIVE compactions and 13 steps also burned the full 600s and
//     landed nothing recoverable — 6 was too generous, and every one of those
//     minutes is taken from every other round in the cell's queue.
// A round that compacts this often has already lost the thread of its own work,
// so a fleet round is cancelled natively and settled as context pressure — it
// then goes through the SAME salvage lane, so the worst case (no report
// recoverable) is exactly today's behaviour, and the best case frees the slot
// minutes early. Rounds that finish normally stay at 1-3 compactions (measured),
// so this line does not touch them.
const EARLY_STOP_COMPACTIONS = 4;
// Only fleet rounds stop early: a web chat is the human's turn and keeps its
// full budget regardless of how often the runtime compacts.
const EARLY_STOP_MIN_ELAPSED_MS = 60_000;
// The wrap-up lane's own budget (fix-fleet-output-salvage D2): 90s proved too
// short — the one live salvage attempt returned nothing. A session that just
// compacted eight times needs room to emit one short call. Still hard-bounded so
// it can never become a second full turn.
const WRAPUP_TIMEOUT_MS = 240_000;
// Bounded retry ladder for a fleet round whose runtime was not ready
// (2026-11-08): the round is transient-blocked, not doomed, so it comes back
// instead of being lost. Escalating delays cover a cold boot (~seconds) and a
// credential-driven restart (~1-2min) without hammering the bridge.
// Exhausted ladder ⇒ the honest `skipped`, exactly as before.
export const RUNTIME_READY_RETRY_LADDER_MS = [30_000, 90_000, 180_000];
// The attempt counter cannot ride `job`: runCronJobTurn rebinds job to a copy
// (roundSeq) before the gate, so a write on it is lost with the copy. Keyed by
// the engine's task id instead — same round, across enqueues.
const readyRetryByJob = new Map();

// Resolve when the live web turn finishes (ctx.isStreaming drops). The engine
// queued this job; "skip because busy" is not an option, so busy means wait.
// Exported for the delegation aggregator — the same never-overlap-a-live-turn
// contract governs the summary injection.
export function waitForIdle(ctx, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (!ctx.isStreaming) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for the live turn to finish"));
      setTimeout(tick, IDLE_POLL_MS);
    };
    tick();
  });
}

// Collect one turn's outcome for a non-live session, persisting it under that
// session as it streams. Registered BEFORE prompt() so no early event is
// missed; always unregistered. `activeTurns` is the abort registry; the
// optional `collectors` map defaults to the cell's shared registry — the
// worker pool passes a worker-local map so worker events never reach the web
// broadcast path. `mirrorSessionId` decouples the collector key from the
// mirror row id (fix-fleet-round-discipline D4): the collector key MUST equal
// the session id the child was prompted with (notifications route by it),
// while the mirror rows land under the stable host session — the fleet round
// rotation prompts the child under a per-round id and mirrors into `cron-<id>`.
// Exported for the delegation aggregator and the worker pool.
export function collectTurn(ctx, sessionId, timeoutMs, activeTurns, collectors = ctx.sessionCollectors, mirrorSessionId = sessionId, { earlyStop = false, earlyStopAfterMs = EARLY_STOP_MIN_ELAPSED_MS, cancelSession = null } = {}) {
  const collected = new Promise((resolve, reject) => {
    let text = "";
    let error = null;
    let usage = null;
    const toolBlocks = [];
    // Overthrow evidence (fix-overflow-attribution D1/D2): the two facts a
    // context-overflow failure needs and never carried — how big the dialogue
    // actually was, and how big the window actually is. Both are recorded from
    // the turn's OWN events:
    //   • contextWindow comes from `request/context` (runtime-resolved). The
    //     catalog's declared value is NEVER used here: on 2026-11-10 four
    //     overflows died at 4.6k–9.6k input against a declared 128k window, so
    //     the declaration is a hypothesis, not a fact.
    //   • lastInputTokens is the largest input+cacheRead any step reported. The
    //     final upstream 400 carries no usage at all, so the newest snapshot we
    //     hold belongs to the step BEFORE the wall — that is the honest number.
    let contextWindow = null;
    let lastInputTokens = 0;
    let usageSteps = 0;
    // 早停的"到点复判"定时器（见 maybeEarlyStop）。
    let earlyStopTimer = null;
    const settle = (fn, arg) => {
      clearTimeout(timer);
      if (earlyStopTimer) clearTimeout(earlyStopTimer);
      collectors.delete(sessionId);
      activeTurns.delete(sessionId);
      // This lane's turn just closed — the shared child may be free now
      // (concurrent-chat-sessions D2). A collector is the ONLY trace a non-web
      // turn leaves, so this is the signal a queued web prompt drains on.
      ctx.onRuntimeIdle?.();
      fn(arg);
    };
    const startedAtMs = Date.now();
    // Context-pressure counter (fix-fleet-turn-budget): the runtime compacts
    // mid-turn when the working set outgrows the window, and each compaction
    // costs tens of seconds. A storm of them is why a fleet round can burn the
    // whole 600s budget and still land NOTHING (live 2026-11-08: 22 of 28
    // timed-out rounds had no report at all; the trace of one shows 240 events
    // over 535s, every large gap inside compaction/start|summary|end).
    // Counting them here is passive: it changes no settlement.
    let compactions = 0;
    // Did this round actually FILE its report? (fix-fleet-output-salvage D2)
    // `hasOutput` only proves the assistant said something — live 2026-11-08:
    // five pressure-killed rounds had output and still landed no report, so the
    // salvage lane declined to help exactly where it was needed. A completed
    // report_status call is the fact that matters.
    let reported = false;
    // Turn metering (add-turn-metering): the first assistant event's absolute
    // timestamp — ttft_ms derives from it at the executor. Absent on a
    // zero-output turn (honest NULL, never a 0).
    let firstAssistantAt = null;
    const timer = setTimeout(
      () => settle(reject, timeoutError(toolBlocks, startedAtMs, Date.now(), { compactions, hasOutput: Boolean(text), reported })),
      timeoutMs,
    );
    // 早停判定（唯一入口）。
    //
    // 原实现只在 `compaction/start` 事件里判，且要求「计数到阈值」与「已跑够
    // 时间下限」在同一事件上同时成立。**开场压缩风暴**会把这条闸门整个绕过去：
    // 前 60 秒内连压 4 次、之后不再压缩 —— 4 次判定时 elapsed 都 <60s，
    // 之后再也没有 compaction 事件可供判定，回合于是跑到预算耗尽。
    //
    // 线上证据（2026-11-09，4 个 cell 的 4493 行 history）：
    //   • 48 次「turn timed out — context pressure」，只有 3 次早停；
    //   • 44 次压缩数已达阈值却没早停，其中 n=4 的 8 次全是这个形状；
    //   • 同一条任务（job_1794128300056_hwmvbw）既早停过、也超时过 ——
    //     差别不在任务本身，而在压缩是否恰好跨越了时间下限。
    // 修法：撞到阈值时若还没到下限，挂一个一次性定时器在到点时复判。
    const maybeEarlyStop = () => {
      if (!earlyStop || !earlyStopEnabled()) return false;
      if (compactions < EARLY_STOP_COMPACTIONS) return false;
      const elapsed = Date.now() - startedAtMs;
      if (elapsed < earlyStopAfterMs) {
        if (!earlyStopTimer) {
          earlyStopTimer = setTimeout(maybeEarlyStop, earlyStopAfterMs - elapsed + 5);
          earlyStopTimer.unref?.();
        }
        return false;
      }
      // Cancel on the bridge that OWNS this session. On the serial chain that is
      // ctx.dshBridge; on the worker pool the session lives in a per-worker child
      // process, so the caller passes its own canceller — sending `session/cancel`
      // to the primary bridge for a worker session is a no-op, and the round keeps
      // burning until its prompt finally resolves (2026-11-10).
      const cancel = typeof cancelSession === "function"
        ? cancelSession
        : (sid) => ctx.dshBridge?.cancelSession?.(sid);
      try { cancel(sessionId)?.catch?.(() => {}); } catch { /* best effort */ }
      const err = timeoutError(toolBlocks, startedAtMs, Date.now(), { compactions, hasOutput: Boolean(text), reported });
      err.message = `turn stopped early — context pressure (${compactions} compactions)`;
      err.earlyStop = true;
      settle(reject, err);
      return true;
    };

    activeTurns.set(sessionId, (reason) => {
      // A bridge abort (runtime restart mid-turn) is an interruption, not a
      // failure: the engine marks the execution `interrupted` instead of
      // `failed` so the UI offers re-run, not an error report.
      const err = new Error(reason);
      err.interrupted = true;
      settle(reject, err);
    });

    // Pre-emptive overflow stop (fix-overflow-attribution D3). Default OFF:
    // the 95% ratio can misfire on a round whose LAST step merely grazes the
    // window and would still have finished, so the ratio is measured for one
    // window before it is allowed to change outcomes.
    const maybePreemptOverflow = () => {
      if (!overflowPreemptEnabled()) return false;
      // No resolved window → nothing to compare against. Staying put is the
      // conservative choice; inventing a fallback window would be the same
      // mistake as trusting the catalog.
      if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
      if (lastInputTokens < contextWindow * OVERFLOW_PREEMPT_RATIO) return false;
      const err = timeoutError(toolBlocks, startedAtMs, Date.now(), { compactions, hasOutput: Boolean(text), reported });
      err.message = `turn stopped early — context overflow (${lastInputTokens}/${contextWindow} input tokens)`;
      err.earlyStop = true;
      // Build the detail here (the message now names the overflow, so the shared
      // builder classifies it) — the catch path takes `e.detail` verbatim.
      err.detail = contextPressureDetail(err.message, {
        compactions,
        reported,
        hasOutput: Boolean(text),
        facts: { contextWindow, lastInputTokens, usageSteps },
        steps: toolBlocks.length,
        toolResults: toolBlocks.filter((b) => b.result !== undefined).length,
      }) ?? err.detail;
      const cancel = typeof cancelSession === "function"
        ? cancelSession
        : (sid) => ctx.dshBridge?.cancelSession?.(sid);
      try { cancel(sessionId)?.catch?.(() => {}); } catch { /* best effort */ }
      settle(reject, err);
      return true;
    };

    collectors.set(sessionId, (notif) => {
      // Run ledger trace tap (agent-fleet-runs D4): a fleet turn never crosses
      // handleDshEvent — this collector is its only observer — so the trace
      // store is fed from here, keyed by the ledger's turn id. No-op for
      // non-fleet turns and when the tap is off.
      ctx.fleetTurnLedger?.tap?.(notif, sessionId, mirrorSessionId);
      const { method, params } = notif;
      if (method === "session.status" && params.status === "idle") {
        return settle(resolve, {
          text, error, usage, firstAssistantAt, compactions, reported,
          // Overflow evidence rides every normal close too, so a failure that
          // arrives later (the upstream error is reported on this same payload)
          // carries the wall it hit.
          contextWindow, lastInputTokens, usageSteps,
        });
      }
      // A user-questions ask in an unattended session (scheduled task or
      // worker slot — both use this collector) has no human to answer it:
      // cancel immediately so the model continues with a cancelled result
      // instead of parking on the child's fallback window. The serialized
      // task queue must not wait 15 minutes for a timeout nobody will answer.
      if (method === "userQuestion/ask" && params?.askId) {
        ctx.dshBridge?.answerUserQuestion
          ?.({ sessionId: params.sessionId, askId: params.askId, cancelled: true })
          ?.catch(() => {});
        return;
      }
      // LLM failure capture rides the bridge-forwarded stream lane's finish
      // frames (restore-assistant-stream-020 — the 0.2.0 session format
      // removed the assistant/chunk event this used to read).
      if (method === "platform/stream") {
        const chunk = params?.frame?.chunk;
        if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
          error = chunk.reason.failure?.message || "LLM request failed";
        }
        return;
      }
      if (method !== "session.event") return;
      const ev = params.event;
      if (!ev) return;
      if (ev.type === "request/context") {
        // The runtime's own resolution of capacity for this request. Never the
        // catalog's declaration (fix-overflow-attribution D2).
        if (Number.isFinite(ev.data?.contextWindow)) contextWindow = Number(ev.data.contextWindow);
        return;
      }
      if (ev.type === "compaction/start") {
        compactions += 1;
        // Early stop: past the hard threshold a fleet round is not going to
        // finish, and the serial slot is the cell's only executor. Cancel it
        // natively and settle as pressure (the salvage lane then tries for the
        // report) instead of holding everyone else's queue for another N seconds.
        maybeEarlyStop();
      }
      if (ev.type === "assistant/message") {
        // Turn metering: the FIRST assistant event is the time-to-first-token
        // anchor (subsequent steps update usage, not the anchor).
        firstAssistantAt ??= Date.now();
        const blocks = ev.data?.message?.content;
        if (Array.isArray(blocks)) {
          const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (t) text = t;
        }
        // Token spend when the runtime reports usage (absent on some
        // providers). dsh attaches TokenUsage to assistant/message, one per
        // step — keep the last (the honest live context size). The whole
        // TokenUsage rides: the metering columns read cacheReadTokens /
        // cacheWriteTokens / reasoningTokens off it (add-turn-metering D4).
        if (ev.data?.usage) {
          usage = ev.data.usage;
          // The size of the dialogue at this step = billed input, i.e. uncached
          // input plus cache reads (normalizeUsage owns the shape drift). Keep
          // the LARGEST seen: a later step can legitimately be smaller after a
          // compaction, and the number we want is the high-water mark the round
          // actually reached.
          const step = normalizeUsage(usage);
          const billed = step ? (step.input ?? 0) + (step.cacheReadTokens ?? 0) : 0;
          if (billed > lastInputTokens) lastInputTokens = billed;
          usageSteps += 1;
          maybePreemptOverflow();
        }
        // Mirror the final message into SQLite WITH the tool-call blocks, the
        // same structure the web path persists — a reloaded job session
        // rebuilds the same evidence trail as a live one. Rows land under the
        // stable mirror session even when the collector key is a rotated
        // per-round child id (fix-fleet-round-discipline D4).
        const persistBlocks = [...toolBlocks, ...(text ? [{ kind: "text", text }] : [])];
        if (text || toolBlocks.length) {
          chatHistory.recordMessage(mirrorSessionId, "assistant", text, persistBlocks);
        }
      } else if (ev.type === "turn/end") {
        // 空回合免单 (F3.3 remainder, fix-error-turn-billing): the UNKNOWN_MODEL
        // silent empty return never emits a platform/stream error finish — its
        // ONLY failure signature is turn/end reason=error. Capture it here so
        // the attempt settles failed instead of riding ok:true into billing.
        if (ev.data?.reason?.kind === "error" && !error) {
          error = ev.data.reason.error?.message || "LLM request failed";
        }
      } else if (ev.type === "tool/call") {
        toolBlocks.push({
          kind: "tool",
          id: ev.data.callId,
          name: ev.data.name,
          args: (() => { try { return JSON.parse(ev.data.arguments); } catch { return ev.data.arguments; } })(),
          // fix-fleet-turn-attribution D1: the timeout summary needs WHEN a
          // call started and whether it ever returned — two fields now, so a
          // stalled call is distinguishable from a budget that simply ran out.
          at: Date.now(),
        });
      } else if (ev.type === "tool/result") {
        const { callId, resultText } = parseToolResult(ev);
        const acc = toolBlocks.find((b) => b.id === callId);
        if (acc) {
          acc.result = resultText;
          acc.resultAt = Date.now();
          // A report only counts once its result came back (a call that never
          // returns wrote nothing).
          if (/report_status/i.test(String(acc.name ?? ""))) reported = true;
        }
      }
    });
  });
  // The abort path (a bridge restart mid-turn) rejects this promise for EVERY
  // registered collector, and a caller whose `await prompt()` threw into its
  // own catch never reaches `await collected` — under node ≥15 an unhandled
  // rejection kills the host process, so a single preset switch could take the
  // whole cell down (observed: the e2e server died mid-suite exactly this
  // way). A second no-op consumer marks the rejection handled without
  // disturbing the real one: consumers still await `collected` and read the
  // interruption there.
  collected.catch(() => {});
  return collected;
}

// Timeout attribution (fix-fleet-turn-attribution D1): the collector's
// closure knows what the turn was doing when the budget ran out — the reject
// just never said so. A call still awaiting its result reads `stalled` (fix
// the tool); all calls returned and the steps simply ran out reads
// `turn_budget_exceeded` (raise the budget or shorten the work). A turn with
// no tool history at all summarizes honestly empty — the model may have been
// thinking, and an invented tool name would misdirect triage.
export function timeoutError(toolBlocks, startedAtMs, now = Date.now(), { compactions = 0, hasOutput = false, reported = false } = {}) {
  const err = new Error("turn timed out");
  const pending = [...toolBlocks].reverse().find((b) => b.result === undefined);
  err.detail = pending
    ? {
        kind: "stalled",
        steps: toolBlocks.length,
        lastTool: pending.name ?? null,
        lastToolWaitedMs: Math.max(0, now - (pending.at ?? startedAtMs)),
        ...(compactions ? { compactions } : {}),
      }
    : {
        kind: "turn_budget_exceeded",
        steps: toolBlocks.length,
        lastTool: toolBlocks.length ? toolBlocks[toolBlocks.length - 1].name ?? null : null,
        ...(compactions ? { compactions } : {}),
      };
  // Naming the cause (fix-fleet-turn-budget): a round that spent its budget
  // compacting is not "a slow turn", it is a round whose working set never fit
  // the window — the owner's fix is a shorter task, not a bigger budget.
  // `hasOutput` travels with the failure so the caller can decide whether a
  // wrap-up report is worth asking for (an empty round is the one that needs it).
  err.detail.hasOutput = hasOutput === true;
  err.detail.reported = reported === true;
  if (compactions >= CONTEXT_PRESSURE_COMPACTIONS) {
    err.detail.contextPressure = true;
    err.message = `turn timed out — context pressure (${compactions} compactions)`;
  }
  return err;
}

// Wrap-up lane (fix-fleet-turn-budget). A fleet round that spent its budget
// compacting lands NOTHING: no summary, no report, and the next cadence fire
// starts from the same wall. The counted evidence (2026-11-08): 22 of 28
// timed-out rounds had no `member_reports` row in their window, and the trace
// of one shows the budget going into repeated compaction.
//
// So after a pressure-flavoured timeout, ask the SAME child session for the one
// thing the round was supposed to produce — its report — under a hard 90s
// ceiling and with tools explicitly refused. Deliberately narrow:
//   • only when the round produced no text at all (a round that already said
//     something is not empty, and a second prompt could overwrite its meaning);
//   • only on a pressure/timeout failure, never on an upstream abort;
//   • any failure here is swallowed — the original failure stays the outcome.
// The salvage DECISION, apart from its effects (fix-fleet-turn-budget): one
// predicate, so the four conditions that must all hold are testable without
// driving a whole fleet turn. Exported for exactly that reason.
// Two shapes of the same failure (fix-fleet-output-salvage D3, live 2026-11-08):
// the runtime either COMPACTS until the budget dies (attributed as
// contextPressure in timeoutError) or refuses outright with
// `context overflow` in ~80-100s. The second used to bypass the salvage lane
// entirely — it returns through the collector's error branch, which carried
// `detail: null`. Both mean "this round could not fit its own work".
export const OVERFLOW_RE = /context overflow|context_length_exceeded|maximum context/i;

export function contextPressureDetail(error, { compactions = 0, reported = false, hasOutput = false, facts = null, steps = null, toolResults = null, priorCacheRead = null, contextWindow = null } = {}) {
  const overflow = OVERFLOW_RE.test(String(error ?? ""));
  const pressured = overflow || compactions >= CONTEXT_PRESSURE_COMPACTIONS;
  if (!pressured) return null;
  return {
    kind: overflow ? "context_overflow" : "turn_budget_exceeded",
    contextPressure: true,
    compactions,
    reported: reported === true,
    hasOutput: hasOutput === true,
    ...(overflow ? { overflow: true } : {}),
    // The wall, in numbers (fix-overflow-attribution D1/D2). Absent facts stay
    // ABSENT rather than defaulted: a null contextWindow means the runtime never
    // told us its capacity, which is different from "the window is 128k".
    ...(Number.isFinite(facts?.lastInputTokens) ? { lastInputTokens: facts.lastInputTokens } : {}),
    ...(Number.isFinite(facts?.contextWindow) ? { contextWindow: facts.contextWindow } : {}),
    ...(Number.isFinite(facts?.usageSteps) ? { usageSteps: facts.usageSteps } : {}),
    ...(Number.isFinite(steps) ? { steps } : {}),
    ...(Number.isFinite(toolResults) ? { toolResults } : {}),
    // WHY it ran out of room (rotate-cron-session-on-context-pressure 4.1):
    // the numbers above say how full it was; this says which cure applies.
    ...attributionFor({ priorCacheRead, contextWindow: contextWindow ?? facts?.contextWindow ?? null }),
  };
}

// WHY this round ran out of room — the two diseases have OPPOSITE cures.
//
//   • HISTORY ACCUMULATION — the session was reused for months and its
//     cacheRead climbed 84,480 → 119,168 → 157,824 against a 128,000 window
//     (cure: rotate the session);
//   • ONE HUGE ROUND — a large tool reply or prompt in a single turn
//     (cure: do less per round).
//
// The judgement uses the PREVIOUS round's cacheRead, never this round's: once
// a round has failed, its own number is polluted by the failure path.
// Reported only when the inputs are known — a guess is worse than silence.
export function attributionFor({ priorCacheRead = null, contextWindow = null } = {}) {
  // `Number(null)` is 0, which would read as "an empty session" and silently
  // claim single_round_too_large. Absent must stay absent.
  if (priorCacheRead === null || priorCacheRead === undefined) return {};
  if (contextWindow === null || contextWindow === undefined) return {};
  const prior = Number(priorCacheRead);
  const window = Number(contextWindow);
  if (!Number.isFinite(prior) || prior < 0) return {};
  if (!Number.isFinite(window) || window <= 0) return {};
  const ratio = prior / window;
  return {
    cause: ratio >= 0.7 ? "history_accumulation" : "single_round_too_large",
    priorCacheRatio: Math.round(ratio * 100) / 100,
  };
}

// Early stop is a fleet-only policy and can be switched off for an operator
// who would rather always use the full budget (FLEET_EARLY_STOP=0).
export function earlyStopEnabled() {
  return process.env.FLEET_EARLY_STOP !== "0";
}

// Pre-emptive overflow stop (fix-overflow-attribution D3). OFF by default: the
// measured window showed 4 of 17 overflows dying far below the declared
// capacity, so the ratio is first measured on real rounds before it is allowed
// to end them. FLEET_OVERFLOW_PREEMPT=1 turns it on.
export const OVERFLOW_PREEMPT_RATIO = 0.95;

export function overflowPreemptEnabled() {
  return process.env.FLEET_OVERFLOW_PREEMPT === "1";
}

// A failed round that still reported tokens did NOT spend a whole round's worth
// (fix-overflow-attribution D4). The marker rides the detail so every read face
// can tell "partial spend" from "the round's total" — an unmarked partial would
// silently understate cost. Kept as its own function so the stamping itself is
// testable: it used to live inline, and removing it broke nothing.
export function markPartialUsage(detail, usage) {
  if (!detail || !usage) return detail;
  return { ...detail, usagePartial: true };
}

export function shouldSalvageReport(detail, { interrupted = false, isFleet = false } = {}) {  // Pressure in EITHER shape: compaction-storm timeout or runtime overflow.
  return detail?.contextPressure === true
    // The round did not file its report. `hasOutput` is NOT the test: live
    // 2026-11-08 showed five pressure-killed rounds that had produced text and
    // still landed nothing — the lane stayed silent exactly where it was needed.
    && detail.reported !== true
    && interrupted !== true
    && isFleet === true;
}

// The error branch's whole job, in one testable place (fix-fleet-output-salvage
// D3): attribute a failure that came back as an ANSWER (context overflow) the
// same way the timeout path attributes its sibling, and salvage the report when
// the predicate says this round needs it.
export async function attributeFailureAndSalvage(ctx, {
  error,
  compactions = 0,
  reported = false,
  text = "",
  childSessionId = null,
  mirrorSessionId = null,
  isFleet = false,
  // Overflow evidence collected by the turn itself (fix-overflow-attribution):
  // the failing upstream answer carries no usage, so these are the only numbers
  // that can describe the wall.
  contextWindow = null,
  lastInputTokens = 0,
  usageSteps = 0,
  steps = null,
  toolResults = null,
  priorCacheRead = null,
} = {}) {
  let detail = contextPressureDetail(error, {
    compactions,
    reported,
    hasOutput: Boolean(text),
    facts: { contextWindow, lastInputTokens, usageSteps },
    steps,
    toolResults,
    priorCacheRead,
  });
  if (!detail) return null;
  let out = detail;
  if (shouldSalvageReport(out, { isFleet })) {
    const salvage = await runWrapUpReport(ctx, { childSessionId, mirrorSessionId });
    out = { ...out, wrapUp: { ok: Boolean(salvage?.text), chars: (salvage?.text ?? "").length } };
  }
  return out;
}

export async function runWrapUpReport(ctx, { childSessionId, mirrorSessionId, timeoutMs = WRAPUP_TIMEOUT_MS } = {}) {
  if (!childSessionId || !ctx?.dshBridge?.prompt) return null;
  const prompt =
    "只做一件事：立刻调用 report_status 提交本轮已有结论（槽位值 + 阻塞项 + 一句摘要）。" +
    "不要调用其他工具，不要解释，不要继续分析，调用完立即结束。没有新数据就报「本轮无新数据」。";
  try {
    const collected = collectTurn(ctx, childSessionId, timeoutMs, new Map(), ctx.sessionCollectors, mirrorSessionId ?? childSessionId);
    await ctx.dshBridge.prompt(childSessionId, [{ type: "text", text: prompt }]);
    const out = await collected;
    return out ?? null;
  } catch {
    return null; // the wrap-up never becomes the round's outcome
  }
}

async function switchPresetForJob(ctx, preset, timeoutMs) {
  // spinMs (add-turn-metering D2): the persona-acquisition cost — the measured
  // wall time of the switch itself, EXCLUDING the idle wait (queue discipline
  // is not restart tax; counting both would double-bill the wait). Last
  // attempt wins; the equality short-circuit reports 0 (nothing to acquire).
  let spinMs = 0;
  for (let attempt = 0; attempt < PRESET_SWITCH_ATTEMPTS; attempt++) {
    await waitForIdle(ctx, timeoutMs);
    if (preset === ctx.currentPreset) return { ok: true, spinMs };
    // switchPresetTo already serializes through runExclusiveRuntimeMutation
    // (server/agent-session.js) — wrapping it again would nest the chain and
    // deadlock. It restarts the bridge, persists the preference and
    // broadcasts current_preset + agent_changed — clients learn the runtime
    // now runs the job's agent.
    const switchT0 = Date.now();
    const r = await ctx.switchPresetTo(preset);
    spinMs = Date.now() - switchT0;
    if (r?.ok) return { ...r, spinMs };
    // A streaming user turn started between the idle wait and the switch —
    // loop and wait again rather than failing the run.
    if (!ctx.isStreaming) return { ...(r ?? {}), spinMs };
  }
  return { ok: false, error: "could not switch the agent for the scheduled task (runtime stayed busy)", spinMs };
}

// ── Per-session persona parking (add-cell-session-persona) ──────────────────
//
// The scheduled lane's persona turns park the turn's preset onto THIS turn's
// child conversation id before its first prompt — the session composes it at
// lazy creation/resume (platform-preset-bridge parked semantics) and the
// runtime's deployment default is never touched. The restart ladder
// (switchPresetForJob above) remains as the EXPLICIT fallback for: an older
// child without preset/set, a live session whose composition mismatches (park
// refused by contract), or a park hard-error. Fallbacks are recorded, never
// silent (spec: cron-module「定时回合的 persona 组合按会话驻留」）.
//
// Returns { legacy: null } when parked (or already parked with the same
// preset this generation), { legacy: reason } when the caller must take the
// byte-parity restart path.
export async function parkPersonaForTurn(ctx, preset, childSessionId) {
  const bridge = ctx.dshBridge;
  if (!bridge || typeof bridge.hasLiveMethod !== "function" || !bridge.hasLiveMethod("preset/set")) {
    return { legacy: "preset/set unsupported by this child" };
  }
  if (typeof bridge.setPreset !== "function") {
    return { legacy: "bridge predates preset/set parking" };
  }
  if (typeof bridge.preparedPreset === "function" && bridge.preparedPreset(childSessionId) === preset) {
    // Already parked with the same preset on THIS child generation — the
    // composition is settled; prompting resumes it as-is.
    return { legacy: null, already: true };
  }
  try {
    await bridge.setPreset({ sessionId: childSessionId, presetId: preset });
    // Park the SKILLS scope too (ledger E24 remainder). Parking only the preset
    // left `skills.patch.yml` at "full" — every turn in this cell carried all 23
    // pack roots (58 skill bodies, ~8KB of `<available_skills>`) no matter which
    // post ran, and that fixed overhead is a large share of the compaction
    // storms (`context pressure (4-6 compactions)`, live 2026-11-09/10). The
    // writer derives a focused list from the preset; a failure here must not
    // fail the turn — the round still runs, just with the wider list.
    try {
      const dshProfile = await import("../dsh-profile.js");
      await dshProfile.writeSkillsPatch({ agentPreset: preset });
    } catch (e) {
      console.warn(`[cron] focused skills patch for ${preset} failed (turn continues on the current list): ${e?.message || e}`);
    }
    return { legacy: null };
  } catch (err) {
    const cls = classifyPresetSetError(err);
    if (cls.refused) return { legacy: "live session composition mismatch (park refused)" };
    return { legacy: `park failed: ${cls.error.message}` };
  }
}

// Stamp the turn's preset path onto an outcome's detail — the observability
// face of the fallback contract (detail.presetPath: "parked" |
// "legacy:<reason>").
function withPresetPath(result, presetPath) {
  if (!presetPath) return result;
  return { ...result, detail: { ...(result.detail ?? {}), presetPath } };
}

// Thinking depth per turn (fix-member-config-complete D2). Extracted so the
// "cleared declaration drives the runtime back to the provider default" branch
// is testable on its own — the whole point of the fix is a judgement the old
// code never reached (it tested truthiness of the target level, so `null` — the
// clear case — was indistinguishable from "nothing to do").
//
// Degrade-open stays: a failed switch is recorded as a notice and the turn runs
// on whatever level is live. Returns the accumulated notices.
export async function applyPostEffort(ctx, plan) {
  const notices = [...(plan?.effortNotices ?? [])];
  const desired = plan?.effort ?? null;
  if (desired === (ctx?.currentEffort ?? null)) return notices;
  const label = desired === null ? "(clear → provider default)" : desired;
  try {
    const r = await ctx.switchEffortTo?.(desired);
    if (r && r.ok === false) notices.push(`thinking level switch to '${label}' failed: ${r.error ?? "unknown error"}`);
  } catch (e) {
    notices.push(`thinking level switch to '${label}' failed: ${e?.message || e}`);
  }
  return notices;
}

// Post-model normalization (add-fleet-post-model D1/D2/D5): the exact mirror
// of the preset normalization above — every persona turn LANDS the runtime on
// the resolution chain's first roster hit instead of riding whatever the
// previous turn (fleet or the user's chat) left behind. Fallback happens at
// selection time only: resolution already roster-filtered the candidates, the
// loop walks past a hop only if the roster drifted between the read and the
// switch. No candidates at all → honest failure, no invented model.
async function normalizeModelForJob(ctx, preset, job = null) {
  const plan = (await ctx.resolveFleetModel?.(preset)) ?? null;
  // Not a fleet post (plain cron task or a persona holding no post): the turn
  // runs on the current model, byte-for-byte the pre-change behavior.
  //
  // BUT a job that DOES carry fleet attribution must not take this door: with
  // no plan there is no model normalization at all, and the call returned
  // `{ok:true}` — which is how three rounds settled `status=ok` with
  // `model=null`, no usage and no trace (ledger E28, live 2026-11-09: the
  // catalog fetch was failing, `resolveFleetModel` came back null, the turn was
  // "successful" without ever running). Losing the post's model resolution is a
  // failure of this round, not a licence to skip it.
  if (!plan) {
    const fleet = job ? fleetTagOf(job) : null;
    if (fleet) {
      return {
        ok: false,
        error: "post model resolution unavailable (catalog/model roster unreachable) — the round would run on an unspecified model",
      };
    }
    return { ok: true };
  }
  const notices = [...plan.notices];
  let landed = null;
  // fix-fleet-model-drift: a post with an explicit chain cannot trust the
  // session ledger's early return — the child can be holding a model some
  // other lane wrote. Force the assertion every round; chain-less posts keep
  // the cheap path unchanged.
  const assertSoft = process.env.FLEET_MODEL_ASSERT_SOFT === "1";
  const force = plan.explicitChain === true && !assertSoft;
  // 预算门（add-model-surface-budget-gate 2.2）：plan.budgetBlocked 是
  // resolveFleetModel 注记的 daily/monthly 超限跳——walk 直接跳过（自然落
  // 降级链下一跳）；全链超限 → budget_exhausted 失败（不进重试，防死循环，
  // spec 日/月超限语义）。probe 在 fleetModelFor 侧已 degrade-open。
  const budgetBlockedModels = new Set((plan.budgetBlocked ?? []).map((b) => b.model));
  for (const hop of plan.candidates) {
    if (budgetBlockedModels.has(hop.model)) {
      const why = (plan.budgetBlocked.find((b) => b.model === hop.model)?.blocked ?? [])
        .map((x) => x.tier)
        .join("+");
      notices.push(`model '${hop.model}' skipped: budget_exhausted (${why || "budget"})`);
      continue;
    }
    const r = await ctx.switchModelTo(hop.model, force ? { force: true } : undefined);
    if (r?.ok) {
      landed = hop.model;
      break;
    }
    notices.push(`model switch to '${hop.model}' failed: ${r?.error || "unknown error"}`);
  }
  if (!landed) {
    const allBudgetBlocked = plan.candidates.length > 0 && plan.candidates.every((hop) => budgetBlockedModels.has(hop.model));
    // 4.3 耗尽即 skip：全链超限时**一个模型都没试**就返回了，这既不是执行失败、
    // 也不是模型配置错——回合根本没开始。记成 `failed` 会把它混进失败率与重跑面
    // （与 lane breaker 打开同一条理由，见 finishExecution 的 D4 注释）。
    // `skipped: true` 让它结算为 skipped；`budgetExhausted` 让历史行标出原因，
    // 否则 skipped 会变成第二个"看不出为什么"的桶。
    return {
      ok: false,
      skipped: allBudgetBlocked,
      budgetExhausted: allBudgetBlocked,
      error: allBudgetBlocked
        ? `budget_exhausted: all candidate models over daily/monthly budget (${notices.length ? notices.join("; ") : "no candidates"})`
        : `no runnable model for this post (${notices.length ? notices.join("; ") : "no model declared and no default available"})`,
    };
  }
  // fix-fleet-turn-attribution D5: the retry loop walks the SAME candidates
  // from where selection landed — the chain's order IS the degrade order.
  const landedIndex = plan.candidates.findIndex((hop) => hop.model === landed);
  if (notices.length) {
    console.warn(`[fleets] post model fallback for ${plan.memberId}: ${notices.join("; ")}`);
    ctx.recordFleetModelNotices?.(plan.memberId, notices);
  } else {
    ctx.recordFleetModelNotices?.(plan.memberId, []);
  }
  // Thinking depth (add-agent-config-dims D1): applied per turn through the
  // LIVE model/set path — no child restart. Same-value switches are skipped
  // (the runtime is already there). A failed effort switch degrades open: the
  // turn runs on whatever level is live rather than failing over a knob.
  // fix-member-config-complete D2: the judgement is "is the target level
  // different", not "does the target level exist". A cleared declaration
  // (plan.effort == null) must drive the runtime BACK to the provider default;
  // skipping it left the previous post's level in place across turns.
  const effortNotices = await applyPostEffort(ctx, plan);
  if (effortNotices.length) console.warn(`[fleets] post config for ${plan.memberId}: ${effortNotices.join("; ")}`);
  return {
    ok: true,
    effort: plan.effort ?? null,
    effortNotices,
    contextBudget: plan.contextBudget ?? null,
    candidates: plan.candidates.map((hop) => hop.model),
    landedIndex,
    landed,
    // fix-fleet-model-drift: the self-heal gate in runPersonaTurn reads
    // modeled.explicitChain — without it the not-available retry was dead
    // code from day one (the plan carries the flag; the normalized shape
    // dropped it). Ride the plan's verdict through.
    explicitChain: plan.explicitChain === true,
  };
}

// ── Member executors ─────────────────────────────────────────────────────────
//
// The two turn shapes a scheduled task (or a cluster fan-out member) can run.
// Both record their exchange in the job's session and return
// { ok, error?, interrupted?, usage?, text? } — `text` is the collected
// assistant reply, consumed only by the cluster aggregation.

// a2a targets (add-agent-delegation-a2a D2): a REMOTE turn — no runtime
// readiness, no preset switch, no dsh prompt. The streamed reply lands in the
// task's dedicated session exactly like a persona execution's output;
// outbound depth is 1 (human-originated delegation baseline — chains get
// +1 only when in-cell turns are themselves delegated, a future state).
async function runA2aRemoteTurn(ctx, job, timeoutMs) {
  const entry = catalog.getAgentEntry(job.preset);
  if (!entry || entry.mode !== "a2a") {
    return { ok: false, error: `market agent '${job.preset}' is not in the catalog (or not a2a)` };
  }
  const sessionId = job.sessionId || `task-${job.id}`;
  chatHistory.recordMessage(sessionId, "user", job.prompt);
  if (job.sessionTitle) {
    try { chatHistory.setTitle(sessionId, job.sessionTitle); } catch { /* prompt-derived title stays */ }
  }
  try {
    const { gatewayToken } = resolveGatewayCredential({
      ownerEmail: ctx.cellUserEmail || null,
      cloudMode: !!ctx.CLOUD_MODE,
    });
    const agentToken = process.env.AGENT_SERVING_BACKEND_TOKEN || "";
    const out = await runA2aTurn(entry.url, job.prompt, {
      contextId: sessionId,
      depth: 1,
      gatewayToken,
      agentToken,
      timeoutMs,
    });
    if (out.text) chatHistory.recordMessage(sessionId, "assistant", out.text);
    ctx.sessionCollectors.delete(sessionId);
    const version = ctx.sessionVersion;
    chatHistory
      .listSessions()
      .then((sessions) => {
        if (version === ctx.sessionVersion) {
          ctx.broadcast({ type: "sessions", sessions: ctx.withTurnStatus?.(sessions) ?? sessions, current: chatHistory.currentSessionId() });
        }
      })
      .catch(() => {});
    // Turn metering (add-turn-metering D3): a2a runs on the REMOTE executor —
    // the enqueue default already says remote for a2a targets, but the executor
    // states it anyway (the claimant/executor rule), and a2a has no persona
    // acquisition (no spin) and no collected stream (no ttft).
    return {
      ok: true, usage: null, text: out.text ?? null,
      metering: {
        carrier: "remote", carrierInstance: null,
        queueWaitMs: _queueWaitMs(job, Date.now()),
      },
    };
  } catch (e) {
    ctx.sessionCollectors.delete(sessionId);
    return {
      ok: false, error: e.message,
      metering: {
        carrier: "remote", carrierInstance: null,
        queueWaitMs: _queueWaitMs(job, Date.now()),
      },
    };
  }
}

// True queue wait = dequeue time − **first** time this fire asked for a slot.
//
// `job.queuedAt` is deliberately re-stamped on every re-enqueue and again by
// drainRepairQueue at boot (task-engine.js), so measuring from it reports only
// the current attempt. After a restart every backlogged fire looks brand new and
// `queue_wait_ms` under-reports exactly when the queue is worst — and that number
// feeds fleet-cost-digest's `queue_wait_ms_max`, i.e. the signal that proposes
// raising cell concurrency. `firstQueuedAt` survives (it is whitelisted in
// saveTasks for this reason); fall back to `queuedAt` when it is absent.
function _queueWaitMs(job, dequeueAt) {
  const anchor = Number.isFinite(job?.firstQueuedAt) ? job.firstQueuedAt : job?.queuedAt;
  if (anchor == null || !Number.isFinite(anchor)) return null;
  return Math.max(0, dequeueAt - anchor);
}

// Round-scoped child conversation disposal (fix-fleet-round-discipline D5):
// best-effort — dsh-bridge.deleteSession already swallows its own failures
// (old runtimes have no session/delete RPC); this never throws and never
// affects the next round, which runs on a fresh rotated id regardless.
async function disposeRoundChild(ctx, childSessionId, mirrorSessionId) {
  if (childSessionId === mirrorSessionId) return;
  try {
    await ctx.dshBridge?.deleteSession?.(childSessionId);
  } catch { /* best-effort: the id is never resumed either way */ }
}

// Fleet round statelessness (fix-fleet-round-discipline D4/D7): the design
// re-renders {{fleetContext}} every round — history contributes nothing —
// yet the dsh child resumes its persisted conversation by session id, so a
// stable id accumulated every round's history (2.3MB in 5 rounds; the
// compaction ate the 600s budget before any work started). The child
// conversation id therefore ROTATES per round; the mirror keeps the stable
// id (collectTurn's mirrorSessionId) so the sidebar stays one readable
// session and the evidence trail keeps accumulating. Non-fleet jobs keep
// the byte-for-byte pre-change shape: the child id IS the mirror id.
// One formula, two readers: runPersonaTurn prompts under it, the run ledger
// registers it (so the collector tap can find the turn by that key).
//
// `seq` breaks the same-millisecond tie. Timestamps alone collide whenever two
// rounds of one post start inside the same ms (retry storms, catch-up racing a
// scheduled fire) — and a colliding id would silently resume the very history
// the rotation exists to drop. The engine's own execution counter rides in, so
// the id is unique per execution without any extra bookkeeping.
// A task's fleet attribution, from EITHER source (fix-legacy-fleet-task-tags).
// `sourceTag` is the modern field, but production holds 2026-10-24-era manual
// tasks that carry `origin.fleet.fleetId` with `sourceTag: null` (111 of 276
// fleet-like tasks in one cell, 42 of 66 in another). Every gate that asked
// `sourceTag?.fleetId` alone therefore treated them as NON-fleet: no session
// rotation, no fleet context injection, no early stop, no report salvage — and
// the failure surfaced only as a 600s round with an empty detail.
// `buildTurnRequest`'s own attribution already read both fields; this makes the
// rest of the runner agree with it.
export function fleetTagOf(job) {
  const fleetId = job?.sourceTag?.fleetId ?? job?.origin?.fleet?.fleetId ?? null;
  if (!fleetId) return null;
  return {
    fleetId,
    memberId: job?.sourceTag?.memberId ?? job?.origin?.fleet?.memberId ?? null,
  };
}

export function roundChildSessionId(job, startedAt, seq = 0) {
  const sessionId = job.sessionId || `cron-${job.id}`;
  if (!fleetTagOf(job)) return sessionId;
  return `${sessionId}#r${startedAt}${seq ? `-${seq}` : ""}`;
}


// fix-fleet-model-drift: model-not-available upstream rejection — the child's
// persisted session can carry a model no lane wrote recently (out-of-band
// compaction/agent-team). When that signature shows up the fleet post SHOULD
// re-assert its declared model with force, not walk the degrade chain.
export function isModelUnavailableError(text) {
  const s = typeof text === "string" ? text : text == null ? "" : String(text);
  return /model_not_available|INVALID_MODEL|cannot find model|no available model|model unavailable/i.test(s);
}

// Fleet rounds land on cold cells: the platform boots its dsh child in the
// background, so a 09:00 cron can fire before the runtime is ready. Waiting
// is bounded and fleet-only — ordinary cron keeps the immediate refusal.
// Exported so the gate itself is testable without a live dsh bridge.
export async function awaitRuntimeReadyForJob(ctx, job, {
  waitMs = readyWaitMs(),
  pollMs = RUNTIME_READY_POLL_MS,
  now = () => Date.now(),
} = {}) {
  if (ctx.dshBridge?.isReady()) return { ok: true };
  if (!fleetTagOf(job)) {
    return { ok: false, error: "the agent runtime is not ready" };
  }
  // A restarting child is "not ready yet, but coming back" — the wait must
  // cover the restart instead of timing out against it. Credential delivery and
  // preset switches both restart the child, i.e. this is exactly the window
  // that follows a "connect the market / reconnect the line" action; the old
  // bare-isReady() poll spent the whole budget there and the round was skipped
  // (2026-11-08 live: 120s elapsed, turn recorded `skipped`, patrol lost).
  // The grace is bounded: at most one extra waitMs.
  const deadline = now() + waitMs;
  // Sticky grace: the first time a restart is observed the budget is extended
  // by one more waitMs and stays extended — a restart that finishes still
  // needs time for the child to come up, so retracting the grace on the last
  // poll would time out exactly where it mattered.
  let bound = deadline;
  while (!ctx.dshBridge?.isReady()) {
    if (ctx.dshBridge?.isRestarting?.() === true) bound = Math.max(bound, now() + waitMs);
    if (now() >= bound || pollMs <= 0) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (!ctx.dshBridge?.isReady()) {
    return {
      ok: false,
      // Retryable: the caller re-enqueues the round instead of losing it.
      retryable: true,
      error: "the agent runtime is not ready (waited for fleet round)",
    };
  }
  return { ok: true };
}

// Exported for the drift self-heal e2e (fix-fleet-model-drift 4.2): the gate
// and its retry ride this exact function — a seam-level test cannot see them.
export async function runPersonaTurn(ctx, job, timeoutMs, activeTurns, { startedAt = Date.now() } = {}) {
  let contextBudget = null;
  // Unattended fleet rounds land on cold cells: the platform boots its dsh
  // child in the background, so a 09:00 cron can fire before the runtime is
  // ready and the whole patrol is lost (2026-10-25 live: one daily patrol
  // failed `runtime_not_ready` and nothing retried).
  const ready = await awaitRuntimeReadyForJob(ctx, job);
  if (!ready.ok) return ready;


  const sessionId = job.sessionId || `cron-${job.id}`;
  // The park target must exist BEFORE the preset decision (add-cell-session-
  // persona): the persona is parked onto THIS turn's child conversation id —
  // fleet rounds rotate it per round, plain bound-session tasks reuse the
  // mirror id. Pure function; hoisting it is observationally identical.
  const childSessionId = roundChildSessionId(job, startedAt, job.roundSeq ?? 0);

  // preset binding: a job without one (legacy record) runs under whatever
  // preset is live, matching its pre-change behavior.
  //
  // Park path (default when the child declares preset/set): park the turn's
  // preset onto the child conversation id — no restart, and the runtime's
  // deployment default is never moved. Legacy path (explicit fallback):
  // byte-for-byte the pre-change behavior. `releaseReservation` is taken
  // BEFORE the legacy switch only: it restarts the child, and bridge.ready
  // drains the web queue (concurrent-chat-sessions D2) — without the
  // reservation a queued web prompt would be dispatched into that restart.
  // The idle wait is shared discipline on BOTH paths (a scheduled turn never
  // interleaves a streaming user turn — turn close is process-serialized, so
  // starting a fleet round mid-chat would starve the user's close); the
  // legacy path's wait lives inside switchPresetForJob.
  let releaseReservation = null;
  // Hoisted for the lane pre-check and the retry walk below: a legacy job
  // without a preset never normalizes, and its turn runs on whatever is live.
  let modeled = null;
  // The preset path this turn took — "parked" | "legacy:<reason>" | null
  // (no-preset legacy record). Rides the outcome detail.
  let presetPath = null;
  // Turn metering (add-turn-metering): the persona-acquisition cost. Park
  // path = 0 (no restart — the slice-① win, measured); legacy = the measured
  // switch; a no-preset job never acquires a persona (honest absence).
  let spinUpMs = null;
  if (job.preset) {
    const park = await parkPersonaForTurn(ctx, job.preset, childSessionId);
    if (park.legacy) {
      presetPath = `legacy:${park.legacy}`;
      console.warn(`[cron-runner] preset park fell back to restart for ${job.id}: ${park.legacy}`);
      releaseReservation = ctx.reserveRuntime?.("cron-preset-switch") ?? null;
      const switched = await switchPresetForJob(ctx, job.preset, timeoutMs);
      spinUpMs = switched.spinMs ?? null;
      if (!switched.ok) {
        releaseReservation?.();
        return withPresetPath(switched, presetPath);
      }
    } else {
      presetPath = "parked";
      spinUpMs = 0;
      try {
        await waitForIdle(ctx, timeoutMs);
      } catch (err) {
        return withPresetPath({ ok: false, error: err.message }, presetPath);
      }
    }
    // Post model (add-fleet-post-model F2): normalize AFTER the preset lands —
    // the two switches short-circuit independently, so a same-persona model
    // change is never swallowed, and switchModelTo's live path flips the model
    // without a second restart when the bridge declares model/set.
    modeled = await normalizeModelForJob(ctx, job.preset, job);
    if (!modeled.ok) {
      releaseReservation?.();
      return withPresetPath(modeled, presetPath);
    }
    // Carry the post's context budget to the settlement seam (add-agent-config-dims):
    // the budget is a property of THIS turn's post, so it rides the turn result.
    if (Number.isFinite(modeled.contextBudget)) contextBudget = modeled.contextBudget;
  }

  // Turn metering (add-turn-metering D3): assembled once, attached to every
  // outcome this turn produces. carrier/carrierInstance come from the
  // execution-carrier mark (enqueue default or worker claim) — the executor
  // never invents them; queue_wait measures the enqueue→dequeue window;
  // provider resolves the LANDED model against the live roster (NULL when
  // unknown — never a guess). ttft rides per-attempt (only a real attempt
  // has one).
  const metering = {
    carrier: job.executionCarrier?.carrier ?? "cell",
    carrierInstance: job.executionCarrier?.instance ?? null,
    queueWaitMs: _queueWaitMs(job, startedAt),
    ...(job.preset ? { spinUpMs } : {}),
    ...(modeled?.landed ? { provider: (ctx.dshModels ?? []).find((m) => m.id === modeled.landed)?.provider ?? null } : {}),
    ...(modeled?.effort ? { effort: modeled.effort } : {}),
  };

  // Fleet post identity (enable-wire-content-fleet D1): a member turn tells the
  // agent which post it executes, so it can name its own production source
  // rather than invent one. This seam serves BOTH wake paths — cron cadence
  // fires and delegation wakes both land here — which is why identity rides the
  // prompt instead of a {{...}} template placeholder (passive posts carry no
  // placeholder at all). Null for non-member turns: prompt stays byte-for-byte.
  // The turn segment (add-fleet-identity-turn) completes the deploy/post/round
  // triple with THIS round's landed child id — cadence rounds rotate it,
  // manual dispatches carry their session id; it is the same value the prompt
  // is dispatched under, so the ledger and the recited source_ref agree.
  const identity = ctx.resolveFleetIdentity?.(job.preset, { turn: childSessionId }) ?? null;
  const prompt = identity ? `${identity}\n\n${job.prompt}` : job.prompt;

  // LAST-MOMENT readiness re-check (ledger E34, live 2026-11-10). Everything
  // between this function's opening `awaitRuntimeReadyForJob` and here can
  // RESTART the shared child: the deferred credential drain, the pre-round line
  // renewal (a renewed token always changes the Authorization header), the
  // preset park, the post-model switch. Each one is correct on its own, but a
  // prompt sent into the gap hits a child that is being replaced — the round
  // then fails `503 api_error` while a direct probe of the same gateway answers
  // 200 (measured five times in a row at 11:53). Waiting here covers every
  // restart source at one seam instead of chasing them one by one.
  try {
    if (ctx.dshBridge?.isReady?.() !== true || ctx.dshBridge?.isRestarting?.() === true) {
      const readyAgain = await awaitRuntimeReadyForJob(ctx, job);
      if (!readyAgain.ok) {
        releaseReservation?.();
        return withPresetPath({ ok: false, error: `runtime not ready at prompt time: ${readyAgain.error}`, metering }, presetPath);
      }
    }
  } catch (e) {
    console.warn(`[cron] last-moment readiness check failed (turn continues): ${e?.message || e}`);
  }

  // The bound session is a normal session: the user can open it, and rows
  // stamped here pick up the (just-switched) preset as their creation fact.
  chatHistory.recordMessage(sessionId, "user", prompt);
  if (job.sessionTitle) {
    try {
      chatHistory.setTitle(sessionId, job.sessionTitle);
    } catch { /* sanitize failure leaves the prompt-derived title */ }
  }

  // Lane breaker pre-check (fix-fleet-turn-attribution D3/D6): judged AFTER
  // model normalization — that is the first point where the lane this turn
  // would use is known. An open lane skips the round rather than feeding it
  // to a wall (the wall counts failures; the skip does not).
  const laneId = typeof ctx.llmLaneForModel === "function" ? ctx.llmLaneForModel(modeled?.landed ?? ctx.session?.model?.id ?? null) : null;
  if (laneId) {
    const br = breakerState(laneId);
    if (br.open) {
      releaseReservation?.();
      return withPresetPath({
        ok: false,
        skipped: true,
        error: `llm lane ${laneId} open until ${new Date(br.openUntil).toISOString()} — round skipped (${br.streak}/${br.threshold} consecutive upstream failures)`,
        metering,
      }, presetPath);
    }
  }

  // fix-fleet-turn-attribution D5: prompt+collect extracted so the candidate
  // walk can retry ONCE on a fast upstream failure. Everything per-attempt is
  // inside; the breaker/ledger/handoffs stay at the seam, once per turn. The
  // model value is pre-positioned into the runtime before each attempt — the
  // param rides for call-site documentation only.
  const attempt = async (_attemptModel) => {
    const collected = collectTurn(ctx, childSessionId, timeoutMs, activeTurns, ctx.sessionCollectors, sessionId, { earlyStop: Boolean(fleetTagOf(job)) });
    // The collector is now the visible trace of this turn — hand the runtime
    // over to it and drop the preset-switch reservation.
    releaseReservation?.();
    try {
      await ctx.dshBridge.prompt(childSessionId, [{ type: "text", text: prompt }]);
      const out = await collected;
      // 空回合免单 (F3.3 remainder): a turn whose collector captured an error
      // (turn/end reason=error with no stream finish — the UNKNOWN_MODEL
      // silent empty return) must settle FAILED, not ride ok:true with an
      // error field into billing. error wins over the collected payload.
      if (out?.error) {
        // A context-overflow failure lands here, not in the catch (the runtime
        // answers instead of hanging). Attribute it like its timeout sibling and
        // run the same salvage lane — an overflowed round is the one that most
        // certainly filed nothing.
        const detail = await attributeFailureAndSalvage(ctx, {
          error: out.error,
          compactions: out.compactions ?? 0,
          reported: out.reported === true,
          text: out.text ?? "",
          childSessionId,
          mirrorSessionId: sessionId,
          isFleet: Boolean(fleetTagOf(job)),
          contextWindow: out.contextWindow ?? null,
          lastInputTokens: out.lastInputTokens ?? 0,
          usageSteps: out.usageSteps ?? 0,
          steps: out.steps ?? null,
          toolResults: out.toolResults ?? null,
        });
        // Keep the usage we DID see (fix-overflow-attribution D4): the turn died
        // on an answer, so its earlier steps' tokens are real spend and used to
        // be thrown away with the whole row. `usagePartial` says so out loud, so
        // a cost read face can never mistake it for a whole-round figure.
        return { ok: false, error: out.error, interrupted: false, detail: markPartialUsage(detail, out.usage), metering, usage: out.usage ?? null };
      }
      // ttft (add-turn-metering): first assistant event − attempt start. The
      // attempt START is the prompt call's wall clock, not the seam's
      // startedAt (model-normalize time is not latency to first token).
      const ttftMs = out?.firstAssistantAt != null ? Math.max(0, out.firstAssistantAt - promptT0) : null;
      // 预算记账草稿（add-model-surface-budget-gate）：每次 attempt 的真实
      // 用量按 attempt 当时的落地模型记一条——降级弃掉的半程也如实入账，
      // 结算缝一次性消费（不藏、不重复）。
      const attemptModel = _attemptModel ?? ctx.session?.model?.id ?? null;
      const tokens = turnTokens(out?.usage);
      if (attemptModel && tokens != null) budgetLedger.push({ model: attemptModel, tokens });
      return { ok: true, ...out, metering: { ...metering, ...(ttftMs != null ? { ttftMs } : {}) } };
    } catch (e) {
      ctx.sessionCollectors.delete(childSessionId);
      activeTurns.delete(childSessionId);
      ctx.onRuntimeIdle?.();
      let detail = e.detail ?? null;
      // Salvage lane (fix-fleet-turn-budget): a round killed by context
      // pressure lands nothing — no summary, no report — and the next cadence
      // fire pays the same wall again. Ask the same session for just its
      // report, bounded and tool-free; the round STAYS failed (it did not
      // finish) but the fleet gets the data it was going to get anyway.
      // Never on an interruption (a restart is not the round's fault) and never
      // when the round already said something (that text IS the round's answer).
      // Record WHY the lane did or did not run (fix-fleet-output-salvage D4):
      // twice tonight a production round showed the cause attributed and still
      // no wrap-up, and every candidate explanation had to be guessed at from
      // the outside. This is one small object on a turn that already failed.
      const salvageFacts = {
        isFleet: Boolean(fleetTagOf(job)),
        interrupted: e.interrupted === true,
        pressure: detail?.contextPressure === true,
        reported: detail?.reported === true,
      };
      if (shouldSalvageReport(detail, { interrupted: salvageFacts.interrupted, isFleet: salvageFacts.isFleet })) {
        if (detail) detail.salvageFacts = salvageFacts;
        const salvage = await runWrapUpReport(ctx, { childSessionId, mirrorSessionId: sessionId });
        detail = { ...detail, wrapUp: { ok: Boolean(salvage?.text), chars: (salvage?.text ?? "").length } };
      } else if (detail?.contextPressure === true) {
        // Pressure but no lane: say which of the four conditions failed.
        detail = { ...detail, salvageSkipped: salvageFacts };
      }
      return { ok: false, error: e.message, interrupted: e.interrupted === true, detail, metering };
    }
  };

  const candidates = modeled?.candidates ?? null;
  const landedIndex = Number.isInteger(modeled?.landedIndex) ? modeled.landedIndex : 0;
  const promptT0 = Date.now();
  const startedWall = Date.now();
  // 预算记账草稿（add-model-surface-budget-gate）：attempt 逐条 push，结算缝消费。
  const budgetLedger = [];
  let result = await attempt(modeled?.landed ?? null);
  let degradedTo = null;

  // fix-fleet-model-drift: when a fleet post carries an explicit chain and the
  // turn dies with an upstream model_not_available (or INVALID_MODEL), the
  // child's saved selection drifted away from what our ledger says — do NOT
  // walk the degrade chain yet. Force re-assert the declared hop (fresh
  // initialize), re-run ONCE, and only fall through to the degrade lane below
  // if that didn't recover.
  if (
    result.ok === false &&
    !result.interrupted &&
    isModelUnavailableError(result.error) &&
    modeled?.explicitChain === true &&
    modeled?.landed
  ) {
    try {
      const rectifiedSwitch = await ctx.switchModelTo?.(modeled.landed, { force: true });
      if (rectifiedSwitch?.ok !== false) {
        const retry = await attempt(modeled.landed);
        if (retry.ok) {
          result = { ...retry, detail: { ...(retry.detail ?? {}), modelRectified: modeled.landed } };
        }
      }
    } catch { /* the original failure stands; degrade lane below runs */ }
  }
  // One retry, only for a FAST upstream-class failure while the chain still
  // has an untried hop. Timeouts and tool failures are the work's own shape —
  // another model would hit them too. The fast-failure window bounds the
  // double-budget risk (upstream 5xx answers in seconds; a real turn doesn't).
  // The gate itself is the pure shouldRetryFastFailure
  // (server/cron-decisions.js, contract-tested) — this seam only feeds it the
  // attempt outcome, the classified error kind, the elapsed wall time and the
  // chain position.
  const retryFastMs = retryFastWindowMs(process.env);
  if (
    shouldRetryFastFailure({
      result,
      errorKind: classifyErrorKind(result.error),
      elapsedMs: Date.now() - startedWall,
      retryFastMs,
      candidates,
      landedIndex,
    })
  ) {
    const nextModel = candidates[landedIndex + 1];
    try {
      const switched = await ctx.switchModelTo?.(nextModel);
      if (switched?.ok !== false) {
        console.warn(`[fleets] post model degraded for ${job.id}: ${modeled?.landed ?? "?"} → ${nextModel} (upstream failure)`);
        degradedTo = nextModel;
        result = await attempt(nextModel);
        if (result.ok && !result.detail) result.detail = { degradedTo: nextModel };
        else if (result.detail) result.detail = { ...result.detail, degradedTo: nextModel };
      }
    } catch { /* switch failure: the original result stands */ }
  }

  // Single-tier budget gate (add-model-surface-budget-gate, spec 单次超限走
  // 降级链): the turn SUCCEEDED but blew the per-turn token cap — the same
  // one-hop degrade the upstream-failure retry rides, gated on the same
  // untried-hop + fast-window conditions (a slow 9k-token answer is the
  // work's own shape; re-running it late doubles the bill for nothing).
  // The over-cap event itself is logged at consume time (settlement seam).
  // The gate is the pure shouldDegradeOverBudget (server/cron-decisions.js).
  if (
    shouldDegradeOverBudget({
      result,
      tokens: turnTokens(result?.usage),
      singleCap: ctx.modelBudget?.config?.single,
      elapsedMs: Date.now() - startedWall,
      retryFastMs,
      candidates,
      landedIndex,
    })
  ) {
    const nextModel = candidates[landedIndex + 1];
    try {
      const switched = await ctx.switchModelTo?.(nextModel);
      if (switched?.ok !== false) {
        console.warn(`[fleets] post model degraded for ${job.id}: ${modeled?.landed ?? "?"} → ${nextModel} (single-turn budget exceeded)`);
        degradedTo = nextModel;
        result = await attempt(nextModel);
        if (result.ok && !result.detail) result.detail = { degradedTo: nextModel, singleBudgetExceeded: true };
        else if (result.detail) result.detail = { ...result.detail, degradedTo: nextModel, singleBudgetExceeded: true };
      }
    } catch { /* switch failure: the original result stands */ }
  }

  // 预算结算缝（add-model-surface-budget-gate）：turn 落幕，按 attempt 草稿
  // 逐条消费（降级弃掉的半程如实入账）；single 超限事件在 consume 里落
  // budget_exhausted_log。degrade-open：引擎缺席/抛错只留 warn，绝不改写
  // 回合结果。
  if (budgetLedger.length) {
    try {
      for (const a of budgetLedger) {
        // 分账归属（4.1）：owner/fleet 从任务自身的来源读，读不到就是 unknown——
        // 绝不回落到"默认舰队"（那会把别人的用量算到无辜的线上）。
        const r = ctx.modelBudget?.consumeBudget?.(a.model, a.tokens, {
          jobId: job.id,
          sessionId,
          owner: job.owner ?? job.ownerEmail ?? ctx.ownerEmail ?? null,
          fleet: job.sourceTag?.fleetId ?? job.origin?.fleet?.fleetId ?? null,
        });
        if (r?.singleExceeded) {
          console.warn(`[fleets] single-turn budget exceeded for ${job.id}: model=${a.model} tokens=${a.tokens} cap=${ctx.modelBudget?.config?.single}`);
        }
      }
    } catch (e) {
      console.warn(`[model-budget] consume failed for ${job.id} (degrade open): ${e?.message || e}`);
    }
  }

  // Round-scoped child disposal (fix-fleet-round-discipline D5): the rotated
  // conversation is dead the moment the round settles — a best-effort delete
  // keeps the child's session store bounded. Failure is harmless by contract:
  // the rotation already guarantees this id is never resumed, so a failed
  // delete only leaves a bounded orphan file behind.
  await disposeRoundChild(ctx, childSessionId, sessionId);

  // Refresh the sidebar/list so a returning client sees the job session's
  // new output (this is the sessions broadcast finishTurn makes on the web
  // path; the cron path never sends `done`, which belongs to live turns).
  const version = ctx.sessionVersion;
  chatHistory
    .listSessions()
    .then((sessions) => {
      if (version === ctx.sessionVersion) {
        ctx.broadcast({ type: "sessions", sessions: ctx.withTurnStatus?.(sessions) ?? sessions, current: chatHistory.currentSessionId() });
      }
    })
    .catch((e) => console.error("[cron] sessions refresh failed:", e.message));

  // metering rides the seam return (add-turn-metering): attempt() stamps it
  // per attempt; a no-attempt ending (shouldn't reach here) falls back to the
  // turn-level assembly.
  // The error branch keeps `usage` too (fix-overflow-attribution D4): a round
  // that died on step 7 DID spend tokens on steps 1–6, and dropping them made
  // every overflow row look like it never ran. `detail.usagePartial` marks it.
  if (result.error) return withPresetPath({ ok: false, error: result.error, detail: result.detail ?? null, metering: result.metering ?? metering, usage: result.usage ?? null }, presetPath);
  return withPresetPath({ ok: true, usage: result.usage ?? null, text: result.text ?? null, contextBudget, detail: result.detail ?? null, degradedTo, metering: result.metering ?? metering }, presetPath);
}

// ── Cluster task orchestration (agent-cluster-platform) ─────────────────────
//
// A cluster task fans its prompt out to the cluster's member agents and
// aggregates their outputs into the task's bound session. Members map to the
// two existing executor shapes: local personas (preset switch + one turn per
// member, own sub-session) and a2a market agents (remote turns). Persona
// members always run sequentially — the primary runtime is ONE shared child
// and a preset switch restarts it, so true parallelism is only possible for
// remote members; with allowParallel the a2a members overlap the persona
// loop, and persona members keep their serial order (an honest degradation,
// never a fanned-out lie).

function memberSessionId(job, agentId) {
  const key = String(agentId).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 64);
  return `${job.sessionId || `cron-${job.id}`}--${key}`;
}

// Resolve the cluster's member agents against the live catalog. Pure —
// exported for tests. Returns one resolution per requested member, in
// cluster order (targetAgents filters, never reorders):
//   { member, entry }     → runnable (entry.kind picks the executor)
//   { member, skip, reason } → not runnable now (pack gone, agent uninstalled,
//                              entry not chat/a2a, persona preset not ready)
export function resolveClusterMembers(cluster, targetAgents, catalogAgents) {
  const wanted = Array.isArray(targetAgents) && targetAgents.length ? new Set(targetAgents) : null;
  const out = [];
  for (const member of cluster.agents ?? []) {
    if (wanted && !wanted.has(member.agentId)) continue;
    const entry =
      catalogAgents.find((a) => a.packId === member.packId && a.id === member.agentId) || null;
    if (!entry) {
      out.push({ member, skip: `pack '${member.packId}' 的 agent '${member.agentId}' 不在当前 catalog（未安装或已卸载）` });
      continue;
    }
    if (entry.mode === "a2a") {
      out.push({ member, entry });
      continue;
    }
    if (entry.mode !== "chat") {
      out.push({ member, skip: `agent '${member.agentId}' 的模式（${entry.mode}）不可执行` });
      continue;
    }
    if (!dshProfile.hasCatalogAgentPreset(entry.id)) {
      out.push({ member, skip: `agent '${member.agentId}' 的本地 persona 预设未就绪` });
      continue;
    }
    out.push({ member, entry });
  }
  return out;
}

// Render the per-member outcome block for the bound session. Pure — exported
// for tests.
export function buildClusterDigest({ clusterName, results, policy }) {
  const lines = [`集群「${clusterName}」任务完成。`];
  const okResults = results.filter((r) => r.status === "ok");
  const badResults = results.filter((r) => r.status !== "ok");

  const aggregation = policy?.resultAggregation ?? "all";
  if (aggregation === "first" && okResults.length > 0) {
    lines.push("", `## ${okResults[0].name} 的输出（first 策略）`, "", okResults[0].text || "(空回复)");
  } else {
    for (const r of okResults) {
      lines.push("", `## ${r.name}${r.model ? `（模型 ${r.model}）` : ""}`, "", r.text || "(空回复)");
    }
  }
  if (badResults.length) {
    lines.push("", "## 未产出成员");
    for (const r of badResults) {
      lines.push(`- ${r.name}：${r.status === "skipped" ? `跳过——${r.reason}` : `失败——${r.error || "未知错误"}`}`);
    }
  }
  // 这里的 `kind` 是本函数**自己写进 results 的载体标签**（persona = 走本地共享
  // 运行时，见下方 results.push），审计官成员也走这条载体、记的也是 "persona"。
  // 换成 isPersonaBackedTargetKind 反而会错：results 里永远不会有 kind ===
  // "auditor"，那会写成"我管了审计官"却一次也匹配不到。
  // persona-only: results 的 kind 是载标签，auditor 也记成 persona
  if (policy?.allowParallel && results.some((r) => r.kind === "persona" && r.status === "ok")) {
    lines.push("", "（并行策略下本地 persona 成员仍按序执行——共享运行时一次只能承载一个 persona；仅远端 a2a 成员真正并行。）");
  }
  return lines.join("\n");
}

async function runClusterTurn(ctx, job, { turnTimeoutMs, activeTurns, startedAt = Date.now(), runPersona, runA2a, listAgents }) {
  const clusterDb = getClusterDatabase();
  const cluster = clusterDb.get(job.preset);
  if (!cluster) {
    return { ok: false, error: `cluster '${job.preset}' no longer exists` };
  }

  const policy = job.executionPolicy ?? {};
  const memberTimeoutMs =
    Number.isFinite(policy.timeoutMinutes) && policy.timeoutMinutes > 0
      ? policy.timeoutMinutes * 60_000
      : turnTimeoutMs;
  const resolutions = resolveClusterMembers(cluster, job.targetAgents, listAgents());
  if (resolutions.length === 0) {
    return { ok: false, error: "cluster has no runnable member agents (empty or all filtered out)" };
  }

  const boundSessionId = job.sessionId || `cron-${job.id}`;
  // Captured BEFORE any member runs — the persona loop switches the shared
  // runtime once per member; this is what it goes back to at the end. The
  // model rides the same rule (add-fleet-post-model D6): single-member turns
  // leave the runtime where they landed it, a fan-out puts it back.
  const originalPreset = ctx.currentPreset || null;
  const originalModel = ctx.session?.model?.id ?? null;

  // ── memory hook ① (add-memory-scopes-and-cluster-sharing; digest upgrade
  // add-cluster-digest-injection) ────────────────────────────────────────────
  // After member resolution, inject the cluster's shared memory into every
  // member's task prompt through the three-rung ladder (SDK digestLadder):
  // digest face (server-rendered, continuation-eval proven) → title list →
  // nothing. Degrade open at every rung: memory never fails a task.
  let taskPrompt = job.prompt;
  const clusterMemory = await clusterMemoryFor(process.env, ctx.runtimeOwnerEmail ?? null);
  if (clusterMemory) {
    taskPrompt = (await memoryInjectionFor(clusterMemory, cluster.id, job.prompt)).prompt;
  }
  chatHistory.recordMessage(boundSessionId, "user", taskPrompt);
  if (job.sessionTitle) {
    try { chatHistory.setTitle(boundSessionId, job.sessionTitle); } catch { /* prompt-derived title stays */ }
  }

  const results = [];
  const personaQueue = [];
  for (const r of resolutions) {
    if (r.skip) {
      results.push({ agentId: r.member.agentId, name: r.member.agentId, kind: "skip", status: "skipped", reason: r.skip });
    } else if (r.entry.mode === "a2a") {
      results.push({
        agentId: r.member.agentId,
        name: r.entry.name || r.member.agentId,
        kind: "a2a",
        status: "pending",
        entry: r.entry,
      });
    } else {
      personaQueue.push(r);
    }
  }

  const runA2aMember = async (slot) => {
    const out = await runA2a(ctx, {
      id: job.id,
      prompt: taskPrompt,
      targetType: "a2a",
      preset: slot.entry.id,
      sessionId: memberSessionId(job, slot.agentId),
      sessionTitle: `${cluster.name} · ${slot.entry.name || slot.agentId}`,
    }, memberTimeoutMs);
    slot.status = out.ok ? "ok" : "failed";
    slot.text = out.text ?? null;
    slot.error = out.error ?? null;
    delete slot.entry;
  };
  const runPersonaMember = async (r) => {
    const preset = dshProfile.rosterPresetId(r.entry.id);
    const out = await runPersona(ctx, {
      id: job.id,
      prompt: taskPrompt,
      targetType: "persona",
      preset,
      sessionId: memberSessionId(job, r.member.agentId),
      sessionTitle: `${cluster.name} · ${r.entry.name || r.member.agentId}`,
      // sourceTag rides down (fix-fleet-round-discipline D7): a fleet-owned
      // cluster's persona members rotate their child conversation id inside
      // runPersonaTurn exactly like a single-post round does.
      sourceTag: job.sourceTag,
    }, memberTimeoutMs, activeTurns, { startedAt });
    results.push({
      agentId: r.member.agentId,
      name: r.entry.name || r.member.agentId,
      kind: "persona",
      status: out.ok ? "ok" : "failed",
      text: out.text ?? null,
      error: out.error ?? null,
      usage: out.usage ?? null,
      // Model attribution (3.15): the runtime's active model id at this
      // member's turn — the lane is the single provider, this names the model.
      model: ctx.runtimeModel?.id ?? null,
    });
    return out;
  };

  // allowParallel overlaps the remote turns with the persona loop; sequential
  // runs everything in member order. The persona loop itself is serial either
  // way (one shared runtime).
  const a2aSlots = results.filter((r) => r.kind === "a2a");
  let remote = null;
  if (a2aSlots.length && policy.allowParallel) {
    remote = Promise.allSettled(a2aSlots.map((s) => runA2aMember(s)));
  }
  let lastPersonaOut = null;
  let firstOkPreset = null;
  for (const r of personaQueue) {
    lastPersonaOut = await runPersonaMember(r);
    if (lastPersonaOut.ok && !firstOkPreset) {
      firstOkPreset = dshProfile.rosterPresetId(r.entry.id);
    }
  }
  if (!remote && a2aSlots.length) {
    for (const s of a2aSlots) await runA2aMember(s);
  } else if (remote) {
    const settled = await remote;
    for (const [i, s] of settled.entries()) {
      if (s.status === "rejected") {
        a2aSlots[i].status = "failed";
        a2aSlots[i].error = s.reason?.message || String(s.reason);
      }
    }
  }

  // Bookkeeping: usage totals ride the cluster row; the fan-out leaves the
  // runtime on the LAST member's persona — put it back where the user had it.
  const totalUsage = results.reduce((acc, r) => {
    const u = r.usage;
    if (!u) return acc;
    return {
      input: (acc?.input ?? 0) + (u.input ?? u.promptTokens ?? 0),
      output: (acc?.output ?? 0) + (u.output ?? u.completionTokens ?? 0),
    };
  }, null);
  try {
    clusterDb.update(cluster.id, {
      lastUsedAt: Date.now(),
      totalExecutions: (cluster.totalExecutions || 0) + 1,
      ...(totalUsage ? { totalTokensUsed: (cluster.totalTokensUsed || 0) + (totalUsage.input || 0) + (totalUsage.output || 0) } : {}),
    });
  } catch (e) {
    console.warn(`[cluster] stats update failed for ${cluster.id}: ${e.message}`);
  }

  const aggregation = policy.resultAggregation ?? "all";
  let digestText = buildClusterDigest({ clusterName: cluster.name, results, policy });
  let summaryRan = false;
  let summarySucceeded = false;

  // summary: one synthesis turn under the first successful persona member,
  // in the BOUND session, fed with every member's output. Falls back to the
  // plain digest when no local member produced output (nothing to lead with).
  if (aggregation === "summary" && firstOkPreset) {
    const outputs = results
      .filter((r) => r.status === "ok" && r.text)
      .map((r) => `【${r.name}】\n${r.text}`)
      .join("\n\n");
    const synthPrompt =
      `以下是集群「${cluster.name}」各成员对同一任务的输出。\n\n原始任务：${job.prompt}\n\n${outputs}\n\n` +
      `请综合以上成员输出，给出一份统一的最终答复：先给结论，再列各成员的关键贡献，最后指出成员间的分歧或缺口（如有）。`;
    const synth = await runPersona(ctx, {
      id: job.id,
      prompt: synthPrompt,
      targetType: "persona",
      preset: firstOkPreset,
      sessionId: boundSessionId,
      sessionTitle: job.sessionTitle || null,
      sourceTag: job.sourceTag, // rotation rides the same D7 rule as members
    }, memberTimeoutMs, activeTurns, { startedAt });
    summaryRan = true;
    if (synth.ok && synth.text) {
      digestText = synth.text;
      summarySucceeded = true;
    } else {
      digestText += `\n\n（汇总回合失败，以上为成员原始输出。失败原因：${synth.error || "未知"}）`;
    }
  }

  // Put the shared runtime back where the user had it. A persona member that
  // failed mid-switch may still have moved it, so the restore keys off "any
  // persona-shaped work happened", not off success.
  if ((personaQueue.length > 0 || summaryRan) && originalPreset && ctx.currentPreset !== originalPreset) {
    try { await switchPresetForJob(ctx, originalPreset, memberTimeoutMs); } catch { /* best-effort */ }
  }
  if ((personaQueue.length > 0 || summaryRan) && originalModel && ctx.session?.model?.id !== originalModel) {
    try { await ctx.switchModelTo(originalModel); } catch { /* best-effort */ }
  }

  // A successful synthesis turn already persisted itself into the bound
  // session (runPersona records its exchange) — recording digestText again
  // would duplicate the reply. Only the self-built digest (all/first, or a
  // failed summary) needs a manual row.
  if (!summarySucceeded) {
    chatHistory.recordMessage(boundSessionId, "assistant", digestText);
  }
  // ── memory hook ② (add-memory-scopes-and-cluster-sharing) ────────────────
  // Write the finalized digest back as a page of the same cluster project —
  // the next cluster turn's hook ① feeds on it. Failure is recorded, never
  // task-failing.
  if (clusterMemory) {
    try {
      await clusterMemory.writeDigest(
        cluster.id,
        `集群回合 ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
        digestText,
      );
    } catch (e) {
      console.warn(`[cluster] digest write-back failed for ${cluster.id} (degrade open): ${e?.message || e}`);
    }
  }
  const version = ctx.sessionVersion;
  chatHistory
    .listSessions()
    .then((sessions) => {
      if (version === ctx.sessionVersion) {
        ctx.broadcast({ type: "sessions", sessions: ctx.withTurnStatus?.(sessions) ?? sessions, current: chatHistory.currentSessionId() });
      }
    })
    .catch((e) => console.error("[cluster] sessions refresh failed:", e.message));

  const okCount = results.filter((r) => r.status === "ok").length;
  const memberModels = Object.fromEntries(results.filter((r) => r.model).map((r) => [r.name, r.model]));
  if (okCount === 0) {
    const errs = results.map((r) => `${r.name}: ${r.status === "skipped" ? r.reason : r.error || "unknown"}`).join("; ");
    return { ok: false, error: `all cluster members failed or were skipped — ${errs}`, models: memberModels };
  }
  return { ok: true, usage: totalUsage, models: memberModels };
}

export function attachCronRunner(ctx, { runPersona = null, runA2a = null, runTool = null, listAgents = null } = {}) {
  // A bridge restart (preset switch, catalog sync, crash respawn) kills any
  // in-flight turn in a job session — the collector would otherwise sit out
  // the full turn timeout and wedge the engine's serialized queue behind a
  // turn that can never finish. dsh-events' bridge.exit branch calls this
  // registry (the bridge captures the event handler by reference at
  // construction, so wrapping ctx.handleDshEvent here would never fire).
  const activeTurns = new Map(); // sessionId -> (reason) => void
  // Exposed so the delegation aggregator's collector registers on the SAME
  // abort registry — a bridge restart aborts every collected turn, not just
  // scheduled ones.
  ctx.taskTurnRegistry = activeTurns;
  ctx.abortCronTurns = (reason) => {
    for (const abort of activeTurns.values()) {
      try {
        abort(reason);
      } catch { /* best-effort abort */ }
    }
    activeTurns.clear();
  };

  // The member executors (cluster fan-out composes these). Injectable so
  // tests drive the orchestration without a live runtime. runTool is the T1
  // tool-post executor (add-tool-posts): one deterministic MCP call.
  const personaExecutor = runPersona || runPersonaTurn;
  const a2aExecutor = runA2a || runA2aRemoteTurn;
  const toolExecutor = runTool || runToolTurnDefault;
  const listAgentsFn = listAgents || catalog.listAgents;

  // `job` is the live engine record (cron.js). Returns { ok, error? }.
  // Turn-event seam (add-fleet-turn-events D1): every turn path converges
  // here, so the outcome event is recorded at this one wrapper — never inside
  // the three executors. Degrade open: a recording failure must never fail
  // the turn it observed.
  ctx.runCronJobTurn = async (job, { turnTimeoutMs } = {}) => {
    const timeoutMs = turnTimeoutMs || resolveTurnBudgetMs(job);
    // Monotonic per-cell sequence alongside the wall clock (retry storms and
    // catch-up runs can start two executions inside one millisecond — the
    // rotated child id must stay unique or the round resumes stale history).
    const startedAt = Date.now();
    const roundSeq = ++roundSeqCounter;
    job = { ...job, roundSeq };

    // Not-executed short-circuit (fix-fleet-turn-veracity D1): a fleet persona
    // round whose runtime never becomes ready inside the bounded wait is
    // skipped, not failed — and the skip lands BEFORE the ledger opens, so the
    // round leaves no run instance, no handoffs, no settle behind it. The
    // inner gate in runPersonaTurn stays as the race fallback (bridge flapping
    // between this pre-gate and the turn itself records failed, honestly).
    // persona-only: targetType 是载体判别（只有 cluster|a2a|tool|persona，
    // 见 cron.js:646），审计官成员的 job 落在 persona 载体上，本比较已含它
    if (job.targetType === "persona" && job.sourceTag?.fleetId) {
      let ready;
      try {
        ready = await awaitRuntimeReadyForJob(ctx, job);
      } catch (e) {
        ready = { ok: false, error: `readiness pre-gate failed: ${e?.message || e}` };
      }
      if (!ready.ok) {
        // Retry ladder (2026-11-08): `skipped` is not a neutral outcome for a
        // PATROL — the round simply never happened and nothing brings it back
        // (the note on the 2026-10-25 incident says exactly that: "that day's
        // patrol was simply lost"). A cold child or a restart in flight is
        // transient, so re-enqueue with backoff instead of losing the round,
        // and fall through to the honest `skipped` only when the ladder is
        // exhausted. The counter rides the engine's live record so the retry
        // continues the SAME round (same prompt/cadence).
        const attempts = readyRetryByJob.get(job.id) ?? 0;
        const delayMs = RUNTIME_READY_RETRY_LADDER_MS[attempts];
        if (ready.retryable === true && delayMs !== undefined && typeof ctx.reenqueueFleetTurn === "function") {
          readyRetryByJob.set(job.id, attempts + 1);
          let scheduled = false;
          try {
            scheduled = ctx.reenqueueFleetTurn(job.id, delayMs) !== false;
          } catch (e) {
            console.warn(`[fleets] re-enqueue after runtime-not-ready failed for ${job.id}: ${e?.message || e}`);
          }
          if (scheduled) {
            const retriedOut = {
              ok: false,
              skipped: true,
              retried: true,
              error: `${ready.error}; re-enqueued in ${Math.round(delayMs / 1000)}s (attempt ${attempts + 1}/${RUNTIME_READY_RETRY_LADDER_MS.length})`,
            };
            try {
              ctx.recordFleetTurnEvent?.(job, retriedOut, { startedAt, endedAt: Date.now(), model: null, ledgerTurn: null });
            } catch (e) {
              console.warn(`[fleets] retried turn record failed for ${job.id}: ${e?.message || e}`);
            }
            console.log(`[fleets] ${job.id}: runtime not ready — re-enqueued in ${Math.round(delayMs / 1000)}s (attempt ${attempts + 1}/${RUNTIME_READY_RETRY_LADDER_MS.length})`);
            return retriedOut;
          }
        }
        readyRetryByJob.delete(job.id); // ladder spent — the next fire starts fresh
        const skippedOut = { ok: false, skipped: true, error: ready.error };
        try {
          ctx.recordFleetTurnEvent?.(job, skippedOut, { startedAt, endedAt: Date.now(), model: null, ledgerTurn: null });
        } catch (e) {
          console.warn(`[fleets] skipped turn record failed for ${job.id}: ${e?.message || e}`);
        }
        return skippedOut;
      }
      // The round really started: the ladder is spent and must not leak into
      // the next fire.
      readyRetryByJob.delete(job.id);
    }

    // Turn-contract admission (agent-turn-contract, explore P2-7): the depth
    // bound is checked where a chain position is created, but a declaration
    // that SHRANK after the hop was queued would let it run past the bound the
    // fleet now states. Refuse BEFORE the ledger opens (same shape as the
    // runtime-not-ready gate above) so the refusal is the turn's honest
    // outcome, recorded — not a silently missing row. Degrade open: no ledger
    // mounted (legacy mounts, tests) means no gate.
    const admission = ctx.fleetTurnLedger?.admission?.(job) ?? null;
    if (admission?.error) {
      const refusedOut = { ok: false, error: `turn contract refused: ${admission.error}` };
      try {
        ctx.recordFleetTurnEvent?.(job, refusedOut, { startedAt, endedAt: Date.now(), model: null, ledgerTurn: null });
      } catch (e) {
        console.warn(`[fleets] refused-turn record failed for ${job.id}: ${e?.message || e}`);
      }
      console.warn(`[fleets] ${job.id}: ${refusedOut.error}`);
      return refusedOut;
    }

    // Run ledger (agent-fleet-runs D2): the turn's id — and for a root turn
    // its run id — exist from the START, because a mid-turn dispatch_post must
    // stamp the upstream turn id on the task it creates. Registered under the
    // mirror session and the rotated child id so the collector tap can find
    // it. Degrade open: a ledger failure never touches the turn.
    let ledgerTurn = null;
    try {
      ledgerTurn = ctx.fleetTurnLedger?.begin(job, { startedAt, sessionIds: [roundChildSessionId(job, startedAt, roundSeq)] }) ?? null;
    } catch (e) {
      console.warn(`[fleet-runs] ledger begin failed for ${job.id}: ${e?.message || e}`);
    }

    // Pre-round credential renewal (add-line-credential-renewal D3 trigger ①):
    // an unattended fleet post must never run on an expired line token. Degrade
    // open — a renewal failure never fails the turn (the round then reports the
    // honest unconnected state instead); a2a/tool shapes are covered too (tool
    // posts read the credential live from the DB, remote turns are unaffected).
    // The drain first delivers any credential restart deferred from the
    // previous turn's streaming window, so this round starts on a child whose
    // patch is current (nothing here can stall the turn — both degrade open).
    try {
      await ctx.drainDeferredCredentialRestart?.();
    } catch (e) {
      console.warn(`[cron] deferred credential restart drain failed: ${e?.message || e}`);
    }
    try {
      await ctx.renewLineCredentialsForTurn?.();
    } catch (e) {
      console.warn(`[cron] pre-round credential renewal failed: ${e?.message || e}`);
    }
    // Renewal may have RESTARTED the runtime child (a renewed token always
    // changes the Authorization header → credentialChanged → restart; ledger
    // E34, live 2026-11-10: every pre-round renewal was followed within ~10s by
    // `credential change: runtime child restarted`, and the round's prompt then
    // went to a child whose session no longer existed → 502/503 → the retry
    // ladder renewed AGAIN → loop). The readiness gate above ran BEFORE the
    // renewal, so it cannot see this restart. Wait here for the fresh child,
    // bounded by the same ladder the pre-gate uses — degrade open if it never
    // comes back (the inner gate still records the failure honestly).
    try {
      if (ctx.dshBridge?.isReady?.() !== true || ctx.dshBridge?.isRestarting?.() === true) {
        const again = await awaitRuntimeReadyForJob(ctx, job);
        if (!again.ok) {
          console.warn(`[cron] post-renewal runtime still not ready: ${again.error}`);
        }
      }
    } catch (e) {
      console.warn(`[cron] post-renewal readiness wait failed: ${e?.message || e}`);
    }

    let out;
    if (job.targetType === "cluster") {
      out = await runClusterTurn(ctx, job, {
        turnTimeoutMs: timeoutMs,
        activeTurns,
        startedAt,
        runPersona: personaExecutor,
        runA2a: a2aExecutor,
        listAgents: listAgentsFn,
      });
    } else if (job.targetType === "a2a") {
      // a2a targets (add-agent-delegation-a2a D2): a REMOTE turn — no runtime
      // readiness, no preset switch, no dsh prompt. The streamed reply lands
      // in the task's dedicated session exactly like a persona execution's
      // output; outbound depth is 1 (human-originated delegation baseline —
      // chains get +1 only when in-cell turns are themselves delegated, a
      // future state).
      out = await a2aExecutor(ctx, job, timeoutMs);
    } else if (job.targetType === "tool") {
      // Tool posts (add-tool-posts): one deterministic MCP call — no dsh
      // runtime, no preset switch, no LLM. Model metadata is meaningless
      // here; the event seam records it null.
      out = await toolExecutor(ctx, job, timeoutMs);
    } else {
      // Turn carrier routing (add-fleet-carrier): runner → the remote executor
      // via the catalog's a2a entry; anything else stays on the primary chain.
      // Fail-open by contract — a runner declaration without a deployment (or
      // an unreachable entry) runs the turn on the primary chain with a
      // recorded carrierFallback, never a refused round.
      let personaJob = job;
      let personaExecutorUsed = personaExecutor;
      const carrier = resolveTaskCarrier(job);
      if (carrier === "runner") {
        delete job.carrierFallback; // fresh per turn — cron task records persist across fires
        const entry = runnerEntryFor(job, { listAgents: listAgentsFn, packId: job.packId ?? null });
        if (entry) {
          personaJob = { ...job, preset: entry.id, targetType: "a2a" };
          personaExecutorUsed = a2aExecutor;
        } else if (job.carrierFallback === "runner-ambiguous") {
          console.warn(`[fleets] carrier runner for ${job.id}: ambiguous a2a entries for '${job.preset}' — failing open to the primary chain`);
        } else {
          console.warn(`[fleets] carrier runner for ${job.id}: no a2a entry for '${job.preset}' — failing open to the primary chain`);
          job.carrierFallback = "runner-no-entry";
        }
      } else if (carrier === "worker" && (!ctx.workerPool || !ctx.workerPool.cap)) {
        console.warn(`[fleets] carrier worker for ${job.id}: worker pool inactive — failing open to the primary chain`);
        job.carrierFallback = "worker-pool-inactive";
      }
      out = await personaExecutorUsed(ctx, personaJob, timeoutMs, activeTurns, { startedAt });
      if (job.carrierFallback) {
        out = { ...out, detail: { ...(out?.detail ?? {}), carrierFallback: job.carrierFallback } };
      }
      // Hollow-success guard (harden-fleet-tool-face-and-queue 3.5 / ledger E21):
      // live 2026-11-09, three rounds settled `ok` with no usage, no model and
      // no trace — the platform restarted mid-turn and the executor's success
      // path handed back an empty `{ok:true}`. Such a round produced NOTHING:
      // no tokens, no text, no tool call. Flag it so settlement records
      // `interrupted` (re-runnable, honest) instead of a success that advances
      // presence and hides the loss.
      if (out?.ok === true && !out.usage && !out.text && !out.toolCalls) {
        out = { ...out, hollow: true };
      }
    }

    try {
      // Stub-turn guard input (fix-stub-turn-success): settlement needs to know
      // not just how many tokens were spent but whether ANYTHING came out —
      // text, a tool call, a report (all three already ride `out` from the
      // collector), plus the two numbers the window check reads.
      const settled = {
        ...(out ?? {}),
        contextWindow: Number.isFinite(out?.contextWindow) ? out.contextWindow : null,
        inputTokens: Number.isFinite(out?.lastInputTokens) ? out.lastInputTokens : null,
      };
      ctx.recordFleetTurnEvent?.(job, settled, {
        startedAt,
        endedAt: Date.now(),
        // The post's context budget (add-agent-config-dims): judged at
        // settlement from the usage the runtime actually reported.
        contextBudget: Number.isFinite(out?.contextBudget) ? out.contextBudget : null,
        // Best-effort model metadata: providers that stamp usage win, else
        // the runtime's landed model (persona turns leave it where they
        // landed — add-fleet-post-model D6), else the cluster's first member.
        // Tool turns carry none — there is no LLM.
        model:
          job.targetType === "tool"
            ? null
            : out?.usage?.model ??
              ctx.session?.model?.id ??
              (out?.models ? Object.values(out.models)[0] ?? null : null),
        // The ledger handle opened above (null for non-fleet turns or when the
        // ledger is absent): the recorder then writes turnId/runId/chain/
        // trace key on the row and broadcasts fleet_turn_ended.
        ledgerTurn,
      });
    } catch (e) {
      console.warn(`[fleets] turn event record failed for ${job.id}: ${e?.message || e}`);
    }
    // Lane breaker accounting (fix-fleet-turn-attribution D3): the seam knows
    // the model the turn ACTUALLY ran on — a degraded retry already moved the
    // runtime, so ctx.session reflects the last hop. A skipped turn records
    // nothing (the wall was never hit this round). Any successful turn closes
    // the breaker — the half-open probe IS this success.
    try {
      const laneModel = job.targetType === "tool" ? null : (out?.usage?.model ?? ctx.session?.model?.id ?? null);
      const laneId = typeof ctx.llmLaneForModel === "function" ? ctx.llmLaneForModel(laneModel) : null;
      if (laneId && !out?.skipped) {
        if (out?.ok === true) recordUpstreamSuccess(laneId);
        else if (classifyErrorKind(out?.error) === "model_upstream") recordUpstreamFailure(laneId);
      }
    } catch { /* breaker accounting must never fail the turn it observed */ }
    // Handoff edges (agent-fleet-orchestration): the same seam, AFTER the
    // outcome event — upstream completion (ok or failed, both honestly)
    // triggers each declared downstream turn. Degrade open likewise. The
    // ledger handle rides along so every ignited task inherits this run.
    // A SKIPPED round produced no upstream work — igniting downstream turns
    // on it would cascade emptiness down the chain.
    if (!out?.skipped) {
      try {
        await ctx.triggerFleetHandoffs?.(job, out, ledgerTurn);
      } catch (e) {
        console.warn(`[fleets] handoff trigger failed for ${job.id}: ${e?.message || e}`);
      }
    }
    // Settle the run AFTER the handoffs are queued: the header closes only
    // when nothing of this run is in flight or waiting (agent-fleet-runs).
    // This job is excluded — the engine marks it done after we return.
    try {
      ctx.fleetTurnLedger?.settle(ledgerTurn?.runId ?? null, { excludeTaskId: job.id });
    } catch (e) {
      console.warn(`[fleet-runs] settle failed for ${job.id}: ${e?.message || e}`);
    }
    return out;
  };
}

export { _queueWaitMs };
