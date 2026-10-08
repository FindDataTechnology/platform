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
import { runA2aTurn, resolveGatewayCredential } from "./a2a-client.js";

const IDLE_POLL_MS = 250;
const PRESET_SWITCH_ATTEMPTS = 3;

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
// broadcast path. Exported for the delegation aggregator and the worker pool.
export function collectTurn(ctx, sessionId, timeoutMs, activeTurns, collectors = ctx.sessionCollectors) {
  return new Promise((resolve, reject) => {
    let text = "";
    let error = null;
    let usage = null;
    const toolBlocks = [];
    const settle = (fn, arg) => {
      clearTimeout(timer);
      collectors.delete(sessionId);
      activeTurns.delete(sessionId);
      fn(arg);
    };
    const timer = setTimeout(
      () => settle(reject, new Error("turn timed out")),
      timeoutMs,
    );
    activeTurns.set(sessionId, (reason) => {
      // A bridge abort (runtime restart mid-turn) is an interruption, not a
      // failure: the engine marks the execution `interrupted` instead of
      // `failed` so the UI offers re-run, not an error report.
      const err = new Error(reason);
      err.interrupted = true;
      settle(reject, err);
    });

    collectors.set(sessionId, (notif) => {
      const { method, params } = notif;
      if (method === "session.status" && params.status === "idle") {
        return settle(resolve, { text, error, usage });
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
      if (method !== "session.event") return;
      const ev = params.event;
      if (!ev) return;
      if (ev.type === "assistant/message") {
        const blocks = ev.data?.message?.content;
        if (Array.isArray(blocks)) {
          const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (t) text = t;
        }
        // Mirror the final message into SQLite WITH the tool-call blocks, the
        // same structure the web path persists — a reloaded job session
        // rebuilds the same evidence trail as a live one.
        const persistBlocks = [...toolBlocks, ...(text ? [{ kind: "text", text }] : [])];
        if (text || toolBlocks.length) {
          chatHistory.recordMessage(sessionId, "assistant", text, persistBlocks);
        }
      } else if (ev.type === "tool/call") {
        toolBlocks.push({
          kind: "tool",
          id: ev.data.callId,
          name: ev.data.name,
          args: (() => { try { return JSON.parse(ev.data.arguments); } catch { return ev.data.arguments; } })(),
        });
      } else if (ev.type === "tool/result") {
        const callId = ev.data?.message?.source?.callId ?? ev.data?.message?.content?.[0]?.toolCallId;
        const resultBlocks = ev.data?.message?.content?.[0]?.content;
        const acc = toolBlocks.find((b) => b.id === callId);
        if (acc) {
          acc.result = Array.isArray(resultBlocks)
            ? resultBlocks.filter((b) => b.type === "text").map((b) => b.text).join("") || null
            : null;
        }
      } else if (ev.type === "assistant/chunk" && ev.data?.chunk?.type === "finish") {
        // Token spend when the runtime reports usage (absent on some
        // providers); captured on every finish, error or not.
        if (ev.data.chunk.usage) usage = ev.data.chunk.usage;
        if (ev.data.chunk.reason?.kind === "error") {
          error = ev.data.chunk.reason?.failure?.message || "LLM request failed";
        }
      }
    });
  });
}

async function switchPresetForJob(ctx, preset, timeoutMs) {
  for (let attempt = 0; attempt < PRESET_SWITCH_ATTEMPTS; attempt++) {
    await waitForIdle(ctx, timeoutMs);
    if (preset === ctx.currentPreset) return { ok: true };
    // switchPresetTo already serializes through runExclusiveRuntimeMutation
    // (server/agent-session.js) — wrapping it again would nest the chain and
    // deadlock. It restarts the bridge, persists the preference and
    // broadcasts current_preset + agent_changed — clients learn the runtime
    // now runs the job's agent.
    const r = await ctx.switchPresetTo(preset);
    if (r?.ok) return r;
    // A streaming user turn started between the idle wait and the switch —
    // loop and wait again rather than failing the run.
    if (!ctx.isStreaming) return r;
  }
  return { ok: false, error: "could not switch the agent for the scheduled task (runtime stayed busy)" };
}

export function attachCronRunner(ctx) {
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

  // `job` is the live engine record (cron.js). Returns { ok, error? }.
  ctx.runCronJobTurn = async (job, { turnTimeoutMs } = {}) => {
    const timeoutMs = turnTimeoutMs || 10 * 60 * 1000;

    // a2a targets (add-agent-delegation-a2a D2): a REMOTE turn — no runtime
    // readiness, no preset switch, no dsh prompt. The streamed reply lands in
    // the task's dedicated session exactly like a persona execution's output;
    // outbound depth is 1 (human-originated delegation baseline — chains get
    // +1 only when in-cell turns are themselves delegated, a future state).
    if (job.targetType === "a2a") {
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
              ctx.broadcast({ type: "sessions", sessions, current: chatHistory.currentSessionId() });
            }
          })
          .catch(() => {});
        return { ok: true, usage: null };
      } catch (e) {
        ctx.sessionCollectors.delete(sessionId);
        return { ok: false, error: e.message };
      }
    }

    if (!ctx.dshBridge?.isReady()) {
      return { ok: false, error: "the agent runtime is not ready" };
    }

    // preset binding: a job without one (legacy record) runs under whatever
    // preset is live, matching its pre-change behavior.
    if (job.preset) {
      const switched = await switchPresetForJob(ctx, job.preset, timeoutMs);
      if (!switched.ok) return switched;
    }

    const sessionId = job.sessionId || `cron-${job.id}`;

    // The bound session is a normal session: the user can open it, and rows
    // stamped here pick up the (just-switched) preset as their creation fact.
    chatHistory.recordMessage(sessionId, "user", job.prompt);
    if (job.sessionTitle) {
      try {
        chatHistory.setTitle(sessionId, job.sessionTitle);
      } catch { /* sanitize failure leaves the prompt-derived title */ }
    }

    const collected = collectTurn(ctx, sessionId, timeoutMs, activeTurns);
    let result;
    try {
      await ctx.dshBridge.prompt(sessionId, [{ type: "text", text: job.prompt }]);
      result = await collected;
    } catch (e) {
      ctx.sessionCollectors.delete(sessionId);
      activeTurns.delete(sessionId);
      return { ok: false, error: e.message, interrupted: e.interrupted === true };
    }

    // Refresh the sidebar/list so a returning client sees the job session's
    // new output (this is the sessions broadcast finishTurn makes on the web
    // path; the cron path never sends `done`, which belongs to live turns).
    const version = ctx.sessionVersion;
    chatHistory
      .listSessions()
      .then((sessions) => {
        if (version === ctx.sessionVersion) {
          ctx.broadcast({ type: "sessions", sessions, current: chatHistory.currentSessionId() });
        }
      })
      .catch((e) => console.error("[cron] sessions refresh failed:", e.message));

    if (result.error) return { ok: false, error: result.error };
    return { ok: true, usage: result.usage ?? null };
  };
}
