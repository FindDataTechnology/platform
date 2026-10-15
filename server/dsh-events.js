// dsh → WS event-translation layer. The dsh runtime emits an append-only
// session event log as `session.event` notifications plus `session.status`
// lifecycle notifications; this maps them onto the frozen WS protocol the
// React frontend already speaks:
//   turn/start          → agent_start (isStreaming already set at dispatch)
//   platform/stream     → text / thinking / (error capture on finish error)
//                         (bridge-forwarded live assistant-stream frames —
//                         restore-assistant-stream-020: the 0.2.0 session
//                         format removed assistant/chunk from session.event)
//   assistant/message   → chat-history record (assistant turn persistence)
//                         + settled-text fallback when nothing streamed
//   tool/call           → tool_start
//   tool/result         → tool_end
//   turn/end (error)    → error
//   session.status idle → finishTurn (done + sessions refresh)
// dsh has no partial-tool-result event, so tool_update is unmapped. Unmapped
// notifications log at debug (DSH_DEBUG) and never drop the turn.

import * as chatHistory from "../chat-history.js";
import * as trace from "./trace.js";
import { recordPackUsage } from "./usage-telemetry.js";
import {
  parseToolSchemas,
  candidateToolNames,
} from "./tool-discovery.js";

// Normalize a `todo/write` snapshot for the wire: keep only `content`/`status`,
// drop entries with no content, coerce an unrecognized status to "pending", and
// count the three states once here so every client renders its header without
// recounting. Returns null when the payload is not a list at all — the caller
// then ignores the event, as the protocol requires (a plan is UI state, never
// worth failing a turn over).
function normalizePlan(raw) {
  if (!Array.isArray(raw)) return null;
  const todos = [];
  for (const item of raw) {
    const content = typeof item?.content === "string" ? item.content : "";
    // Whitespace-only content would render as an invisible row; drop it rather
    // than send the UI a row nobody can read.
    if (!content.trim()) continue;
    const status =
      item.status === "in_progress" || item.status === "completed" ? item.status : "pending";
    todos.push({ content, status });
  }
  const counts = { pending: 0, inProgress: 0, completed: 0 };
  for (const t of todos) {
    if (t.status === "pending") counts.pending += 1;
    else if (t.status === "in_progress") counts.inProgress += 1;
    else counts.completed += 1;
  }
  return { todos, counts };
}

// A 401 from a ref-carrying MCP endpoint means the stored credential for that
// ref is no longer accepted (expiry, revocation, restart). Mark it invalid —
// profile generation then treats it as absent — and ping the clients so the
// Store can prompt for a re-connect/re-paste (registry: registry-credentials;
// connector: connector-credentials, design D7). Dispatch is by ref name through
// the credential-refs table. dsh names MCP tools `mcp__<serverName>__<toolName>`
// (dsh-profile), so the failing tool identifies the server whose config to
// check for a credential ref.
const UNAUTHORIZED_RE = /\b401\b|unauthoriz/i;

function markCredentialStaleOn401(ctx, toolName, resultText) {
  if (!toolName || !resultText || !UNAUTHORIZED_RE.test(resultText)) return;
  const serverName = /^mcp__(.+?)__/.exec(toolName)?.[1];
  if (!serverName) return;
  Promise.all([import("../extension-store.js"), import("../credential-refs.js"), import("node:fs"), import("node:path")])
    .then(([extensionStore, credentialRefs, fs, nodePath]) => {
      // The failing server may be a DB record (market installs) or a baseline
      // mcp.json row (the connector row) — resolve the config from either.
      let config = extensionStore.getMcpServer(serverName)?.config;
      if (!config) {
        try {
          const mcpPath = nodePath.resolve(process.env.MCP_CONFIG_PATH || "mcp.json");
          config = JSON.parse(fs.readFileSync(mcpPath, "utf8")).mcpServers?.[serverName];
        } catch { /* no mcp.json / unreadable — nothing more to look up */ }
      }
      const entry = credentialRefs.refFor(config);
      if (!entry) return;
      const owner = ctx.runtimeOwnerEmail;
      // false ⇒ already stale: the profile was re-applied then, so a run of
      // 401s costs exactly one re-apply.
      if (!entry.markInvalid(owner)) return;
      console.warn(
        `[${entry.refName}] 401 from MCP server "${serverName}" — credential for ${owner || "the machine owner"} marked invalid`,
      );
      ctx.broadcast?.({ type: entry.staleEvent });
      // The server cannot authenticate any more; drop it from the effective
      // profile now rather than leaving a call that fails every time. Groups
      // are the last-applied owner's, so the role filter is preserved.
      ctx
        .dshUpdateMcp?.(ctx.runtimeMcpOverlay ?? null, ctx.runtimeOwnerGroups ?? null, owner)
        ?.catch((e) => console.warn(`[${entry.refName}] profile update after stale mark failed: ${e.message}`));
    })
    .catch((e) => console.warn(`[credential-refs] stale detection failed: ${e.message}`));
}

export function attachDshEvents(ctx) {
  // The plan message for a session: the cached snapshot, or an explicit empty
  // list when the session has none. Sending the empty form (rather than
  // nothing) is what guarantees a client that just switched sessions can never
  // keep the previous session's plan on screen. Shared by the connect-time
  // syncs (ws.js) and the new-session/session-load paths (agent-session.js).
  ctx.planMessage = (sessionId) => {
    const plan = sessionId ? ctx.planBySession.get(sessionId) : null;
    return plan
      ? { type: "todos", todos: plan.todos, counts: plan.counts }
      : { type: "todos", todos: [], counts: { pending: 0, inProgress: 0, completed: 0 } };
  };

  // The pending-question message for a session, or null when none is pending
  // (add-user-questions). Unlike planMessage there is NO empty form: an absent
  // question pushes nothing — the client clears its card on session_loaded and
  // on the ask's own tool_end, so a null here never strands a stale card.
  ctx.questionMessage = (sessionId) => {
    const pending = sessionId ? ctx.pendingQuestionBySession.get(sessionId) : null;
    if (!pending) return null;
    return {
      type: "agent_question",
      askId: pending.askId,
      ...(pending.toolCallId ? { toolCallId: pending.toolCallId } : {}),
      questions: pending.questions,
    };
  };

  // Per-chat-session MCP server gates (live-runtime-control tools/set). The
  // child's gate is per-child state, so the host keeps the durable intent here
  // and re-asserts it to the bridge at every turn dispatch of an enabled
  // session (self-healing across child restarts; default needs no assertion —
  // the child composes gates closed).
  ctx.sessionToolGates = new Map(); // chatSessionId -> Map<server, boolean>
  ctx.setSessionToolGate = (sessionId, server, enabled) => {
    let byServer = ctx.sessionToolGates.get(sessionId);
    if (enabled) {
      if (!byServer) {
        byServer = new Map();
        ctx.sessionToolGates.set(sessionId, byServer);
      }
      byServer.set(server, true);
    } else if (byServer) {
      byServer.delete(server);
      if (byServer.size === 0) ctx.sessionToolGates.delete(sessionId);
    }
  };
  // The tool_gate sync message for a session's viewers — always sent (the
  // empty form is the default-closed state), so a client that just switched
  // sessions can never keep the previous session's toggle on screen. Mirrors
  // planMessage's contract.
  ctx.toolGateMessage = (sessionId) => ({
    type: "tool_gate",
    sessionId,
    server: "websearch",
    enabled: ctx.sessionToolGates.get(sessionId)?.get("websearch") === true,
  });

  // Mark one session's agent turn finished: reset its streaming flag, broadcast
  // `done` to that session's viewers, and refresh the sidebar list. Idempotent
  // per turn — it no-ops if that session has no open turn — so it is safe from
  // both the session-status idle handler and the prompt() catch. Per-session
  // (live-runtime-control D4): concurrent sessions each own their close.
  ctx.finishTurn = (outcome, sid = ctx.dshSessionId) => {
    const T = ctx.turnStateBySession.get(sid);
    if (!T?.isStreaming) return;
    T.isStreaming = false;
    // Usage telemetry (add-pack-usage-telemetry): one row per completed turn,
    // failure-isolated inside. Captured BEFORE the origin resets below; the
    // outcome falls back to the turn's own error flag when the caller (the
    // idle path) doesn't name one.
    recordPackUsage({
      userEmail: T.origin?.user ?? null,
      sessionId: T.origin?.sessionId ?? sid,
      agentId: ctx.currentAgentId ?? "local",
      outcome: outcome ?? (T.error ? "error" : "ok"),
      startedAt: T.startedAt,
    });
    // `done` closes the turn for exactly the clients viewing the session it
    // ran in (add-session-ownership); a foreign viewer never saw the turn and
    // must not see its close either. The payload carries the turn's token
    // usage when the runtime reported one (chat-usage-display).
    ctx.sendToViewers(sid, {
      type: "done",
      ...(T.usage ? { usage: T.usage } : {}),
    });
    T.origin = null;
    T.usage = null;
    // The replay log is only for an in-flight turn (add-reconnect-resync) —
    // post-done the persisted transcript is the truth a sync serves.
    ctx.resetTurnBuffer?.(sid);
    ctx.turnStateBySession.delete(sid);
    void ctx.broadcastSessions();
  };

  // Per-turn tool-roster projection for UNKNOWN_TOOL candidate recovery
  // (add-tool-discovery-layer). `request/header` carries the exact tool
  // schemas sent to the model this turn; we project them to the matcher's
  // metadata shape and DROP the raw header immediately — the full roster can
  // be very large and the host has no other use for it. Bot sessions have no
  // web transcript, so only the web path (this handler) needs it.
  let turnToolRecords = [];
  ctx.unknownToolCandidates = (attemptedName) => {
    try {
      return candidateToolNames(turnToolRecords, attemptedName);
    } catch {
      return [];
    }
  };

  ctx.handleDshEvent = (notif) => {
    const { method } = notif || {};
    // Session routing (design D2 + live-runtime-control D4). One dsh runtime
    // multiplexes the web chat, every bot chat, and subagent children:
    //   - a notification whose session has a registered collector → collector
    //     (bot chats; NEVER the WS broadcast path — that is what keeps bot
    //     turns out of the web transcript);
    //   - a session the WEB path drove (registered in webTurnSessions, or the
    //     session manager's current one) → the web machinery keyed by THAT
    //     sid, even when the manager has since moved on — concurrent web
    //     turns stay visible;
    //   - anything else (subagent children, unclaimed) → captured/dropped as
    //     before;
    //   - no sid (bridge lifecycle) → the manager's current session.
    const notifSid = notif?.params?.sessionId || null;
    const isWebScoped = !notifSid
      || notifSid === ctx.dshSessionId
      || ctx.webTurnSessions.has(notifSid);
    const webSid = isWebScoped ? (notifSid ?? ctx.dshSessionId) : null;
    // Trace tap first: record everything (raw), before the WS translation
    // switch drops unknown event types. Failure-isolated inside record().
    trace.record(notif, {
      sessionId: webSid ?? ctx.dshSessionId,
      turnId: (webSid && ctx.turnStateBySession.get(webSid)?.currentTurnId) ?? null,
    });

    if (method === "bridge.ready") {
      ctx.ready.dsh = true;
      // During initial boot the session shim is attached after the bridge starts;
      // the composition root performs the ready sync once that state exists.
      if (ctx.session) ctx.onDshReady?.();
      return;
    }
    // Bridge lifecycle notifications have no session id and must abort a live
    // web turn when the child exits before it can emit session.status idle.
    if (method === "bridge.exit" || method === "_bridge_crash") {
      ctx.ready.dsh = false;
      // A dead child releases every pending ask (the provider rejects them
      // in-child); the host's pending cards must not outlive the runtime.
      ctx.pendingQuestionBySession.clear();
      // A restart kills any in-flight scheduled-task turn too: its collector
      // sits on a session that will never report idle, which would wedge the
      // cron engine's serialized queue for the full turn timeout.
      ctx.abortCronTurns?.("the agent runtime restarted mid-turn");
      // Per-session D4: every open web turn closes with the child, each to its
      // own viewers.
      for (const openSid of ctx.streamingSessions()) {
        ctx.sendToViewers(openSid, { type: "error", message: "Agent runtime exited unexpectedly" });
        ctx.finishTurn("error", openSid);
      }
      return;
    }

    if (notifSid && !isWebScoped) {
      // En-route capture (add-llm-retry-resilience): a subagent child session
      // has no collector, but its terminal turn/end reason is the ONLY place
      // the child's real failure (e.g. a gateway concurrency rejection) is
      // stated — the subagent tool maps it to a bare "subagent run failed".
      // Record it before the drop so the parent's tool_end can attach it as a
      // Diagnostic. Pruned by age: entries only need to outlive the seconds
      // between a child's death and its parent's tool result.
      if (
        method === "session.event" &&
        notif.params.event?.type === "turn/end" &&
        notif.params.event?.data?.reason?.kind === "error"
      ) {
        const err = notif.params.event.data.reason.error ?? {};
        ctx.childTurnErrors ??= new Map();
        ctx.childTurnErrors.set(notifSid, {
          message: typeof err.message === "string" ? err.message : null,
          code: typeof err.code === "string" ? err.code : null,
          ts: Date.now(),
        });
        const staleBefore = Date.now() - 15 * 60_000;
        for (const [k, v] of ctx.childTurnErrors) {
          if (v.ts < staleBefore) ctx.childTurnErrors.delete(k);
        }
      }
      const collector = ctx.sessionCollectors.get(notifSid);
      if (collector) {
        try { collector(notif); }
        catch (e) { console.error(`[dsh] session collector ${notifSid} failed: ${e.message}`); }
      } else if (process.env.DSH_DEBUG) {
        console.debug("[dsh] notification for unclaimed session:", notifSid, notif.method);
      }
      return;
    }
    const sid = webSid;
    const T = sid ? ctx.turnStateFor(sid) : null;
    const { params } = notif || {};
    // Live delta lane (restore-assistant-stream-020): the 0.2.0 session
    // format dropped assistant/chunk from session.event, so the bridge
    // forwards the runtime's assistant-stream frames on this dedicated
    // notification. Web-scoped frames map straight onto the viewer text/
    // thinking events; bot-lane sessions never reach here — their frames
    // were routed to the session collectors above (same source, their lane).
    if (method === "platform/stream") {
      const frame = params?.frame;
      if (sid && frame?.type === "start" && T) {
        // One attempt = one model request = one settled segment. The fallback
        // marker is per-SEGMENT: a new attempt resets it so a multi-step turn
        // where only some steps streamed still falls back each silent step.
        T.streamedText = false;
      }
      if (sid && frame?.type === "chunk" && frame.chunk) {
        const chunk = frame.chunk;
        if (chunk.type === "text-delta" && chunk.text) {
          T.streamedText = true;
          ctx.sendToViewers(sid, { type: "text", delta: chunk.text });
        } else if (chunk.type === "reasoning-delta" && chunk.text) {
          T.streamedText = true;
          ctx.sendToViewers(sid, { type: "thinking", delta: chunk.text });
        } else if (chunk.type === "finish" && chunk.reason?.kind === "error") {
          // The LLM failure capture (formerly the chunk-lane finish branch):
          // broadcast rides the turn-completion signal, then session.status
          // idle → finishTurn → done.
          if (T) T.error = chunk.reason.failure?.message || "LLM request failed";
        }
      }
      return;
    }
    // A user-questions ask surfaced by the child's provider bridge
    // (add-user-questions, ADR-0012). The session routing above already sent
    // bot sessions to their collectors — reaching here means the WEB session
    // asked: hold the pending ask for reconnect syncs and hand it to every
    // viewer. The ask never enters the session log (the child emits it as a
    // dedicated notification, not a session event).
    if (method === "userQuestion/ask") {
      const askId = typeof params?.askId === "string" ? params.askId : null;
      const questions = Array.isArray(params?.questions) ? params.questions : [];
      if (!askId || questions.length === 0) {
        if (process.env.DSH_DEBUG) console.debug("[dsh] malformed userQuestion/ask; ignored");
        return;
      }
      // Anchor the card to this turn's ask_user_question tool call so the
      // client binds the interactive card to its transcript block. Tool calls
      // run serially within a turn, so the last call of that name is the ask.
      let toolCallId = null;
      for (const [callId, name] of T?.toolNames ?? []) {
        if (name === "ask_user_question") toolCallId = callId;
      }
      ctx.pendingQuestionBySession.set(sid, { askId, questions, toolCallId });
      ctx.sendToViewers(sid, {
        type: "agent_question",
        askId,
        ...(toolCallId ? { toolCallId } : {}),
        questions,
      });
      return;
    }
    if (method === "session.status") {
      if (params?.status === "idle") ctx.finishTurn(undefined, sid);
      return;
    }
    if (method !== "session.event") {
      if (process.env.DSH_DEBUG)
        console.debug("[dsh] notification:", method, JSON.stringify(params)?.slice(0, 200));
      return;
    }
    const ev = params?.event;
    if (!ev) return;
    if (process.env.DSH_DEBUG) console.log("[dsh-debug] event:", ev.type, JSON.stringify(ev.data)?.slice(0, 600));
    switch (ev.type) {
      case "request/header": {
        // Project the CURRENT request's tool schemas into matcher records and
        // drop the raw header. This is the roster the model can actually call
        // this turn — the authoritative candidate source for unknown-tool
        // recovery. Malformed headers degrade to an empty roster (candidates
        // then fall back to "no suggestion", never to a wrong name).
        try {
          turnToolRecords = parseToolSchemas(ev.data?.header?.tools);
        } catch {
          turnToolRecords = [];
        }
        break;
      }
      case "llm/retry":
      case "llm/retry-started": {
        // Bounded model-request retry (add-llm-retry-resilience): transient
        // failure scheduled for retry / retry wait elapsed, attempt starting.
        // Forwarded as turn progress only — the durable history is untouched
        // (the event is non-surface by design; the retried request re-enters
        // as a fresh numbered turn the client never mistakes for content).
        if (ev.type === "llm/retry") {
          const failure = ev.data?.failure ?? {};
          ctx.sendToViewers(ctx.dshSessionId, {
            type: "retry_scheduled",
            retryId: ev.data?.retryId ?? null,
            provider: ev.data?.provider ?? null,
            mode: ev.data?.mode ?? "normal",
            retry: ev.data?.retry ?? null,
            ...(typeof ev.data?.maxRetries === "number" ? { maxRetries: ev.data.maxRetries } : {}),
            delayMs: ev.data?.delayMs ?? null,
            failure: {
              code: typeof failure.code === "string" ? failure.code : null,
              message: typeof failure.message === "string" ? failure.message : null,
            },
          });
        } else {
          ctx.sendToViewers(ctx.dshSessionId, {
            type: "retry_started",
            retryId: ev.data?.retryId ?? null,
            retry: ev.data?.retry ?? null,
          });
        }
        break;
      }
      case "turn/start":
        // One agent_start per turn (per-session D4). The streaming flag was
        // already set synchronously at prompt dispatch so a concurrent prompt
        // on the same session observes it; re-affirm here idempotently.
        T.isStreaming = true;
        T.error = null;
        T.usage = null;
        T.toolNames.clear();
        T.blocks = [];
        T.streamedText = false;
        // A fresh turn starts a fresh replay log (add-reconnect-resync) —
        // this agent_start below is the log's first event.
        ctx.resetTurnBuffer?.(sid);
        // The declared channel's scope: a `chart_bind` declaration may only
        // reach a chart captured during THIS turn.
        T.chartScopeSince = new Date().toISOString();
        ctx.sendToViewers(sid, { type: "agent_start" });
        break;
      // (assistant/chunk is gone: the 0.2.0 session format removed the event
      // type and the live stream moved to the bridge-forwarded platform/stream
      // lane handled above — restore-assistant-stream-020.)
      case "assistant/message": {
        // Mirror the assistant's final text into the SQLite project database
        // (on assistant/message), now WITH the turn's block structure — the
        // tool calls accumulated below survive reload instead of flattening
        // to prose. Records when text OR tool evidence exists.
        const blocks = ev.data?.message?.content;
        let text = "";
        if (Array.isArray(blocks)) {
          text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
        }
        // Token usage (chat-usage-display): dsh attaches the step's TokenUsage
        // to assistant/message (NOT to the raw finish chunk — the adapter
        // emits a separate `usage` chunk before finish). Keep the LAST step's
        // numbers: a multi-step turn reports one per model request, and the
        // final request's input is the honest live context size.
        const stepUsage = ev.data?.usage;
        if (stepUsage && typeof stepUsage.inputTokens === "number") {
          T.usage = {
            inputTokens: stepUsage.inputTokens,
            outputTokens: typeof stepUsage.outputTokens === "number" ? stepUsage.outputTokens : 0,
          };
        }
        const persistBlocks = [
          ...T.blocks,
          ...(text ? [{ kind: "text", text }] : []),
        ];
        // Settled-text fallback (restore-assistant-stream-020): when nothing
        // streamed this segment (no delta lane, or a non-streaming model
        // response), the settlement is the only text source — emit it exactly
        // once as a single full delta so the transcript never ends without
        // visible body text. Deltas already delivered → persistence only.
        if (text && sid && !T.streamedText) {
          T.streamedText = true;
          ctx.sendToViewers(sid, { type: "text", delta: text });
        }
        if (text || T.blocks.length) {
          // The assistant mirror attributes to the turn's origin session and
          // carries its origin user — stamp-once, so this only fills an
          // ownerless row (add-session-ownership).
          chatHistory.recordMessage(
            T.origin?.sessionId ?? sid,
            "assistant",
            text,
            persistBlocks,
            T.origin?.user ?? null
          );
        }
        break;
      }
      case "tool/call": {
        T.toolNames.set(ev.data.callId, ev.data.name);
        // Accumulate for persistence (result/state filled by tool/result).
        T.blocks.push({
          kind: "tool",
          id: ev.data.callId,
          name: ev.data.name,
          // dsh carries raw JSON string arguments; parse to match the WS contract.
          args: (() => { try { return JSON.parse(ev.data.arguments); } catch { return ev.data.arguments; } })(),
        });
        ctx.sendToViewers(sid, {
          type: "tool_start",
          toolCallId: ev.data.callId,
          name: ev.data.name,
          args: T.blocks[T.blocks.length - 1].args,
        });
        break;
      }
      case "tool/result": {
        const callId =
          ev.data?.message?.source?.callId ?? ev.data?.message?.content?.[0]?.toolCallId;
        const resultBlocks = ev.data?.message?.content?.[0]?.content;
        let resultText = Array.isArray(resultBlocks)
          ? resultBlocks.filter((b) => b.type === "text").map((b) => b.text).join("") || null
          : null;
        const isError = !!ev.data?.error || !!ev.data?.message?.content?.[0]?.isError;
        // UNKNOWN_TOOL recovery (add-tool-discovery-layer): a failed call gets
        // exact-name candidates from the CURRENT request roster, appended to
        // the result text BEFORE broadcast and persistence — the model reads
        // its next turn from the same text the user sees. No candidate is ever
        // executed here; the model must issue the next (exact) call itself.
        if (isError && resultText && ev.data?.error?.code === "UNKNOWN_TOOL") {
          const attempted =
            T.toolNames.get(callId) ?? /^Error: unknown tool "([^"]+)"/.exec(resultText)?.[1];
          if (attempted) {
            const candidates = ctx.unknownToolCandidates?.(attempted) || [];
            resultText = candidates.length
              ? `${resultText}\nExact effective-tool candidates:\n${candidates
                  .map((c) => `- ${c}`)
                  .join(
                    "\n",
                  )}\nRetry with one exact full name, or use tool_search to inspect the roster. No candidate was executed.`
              : `${resultText}\nNo similar effective tool exists. Use tool_search to list what IS available — do not guess another name. Nothing was executed.`;
            // Rewrite the wire text so model-visible transcript, WS event and
            // persistence all carry the same enriched guidance.
            const firstText = resultBlocks?.find?.((b) => b.type === "text");
            if (firstText) firstText.text = resultText;
          }
        }
        // Resilience contract visibility (add-llm-retry-resilience): the
        // subagent tool maps an error stop to the bare headline "subagent run
        // failed" — a child killed by a transient gateway rejection carries no
        // diagnostic of its own, leaving the user and the parent model with
        // nothing actionable. The child's turn/end reason was captured en route
        // (session routing above); append it as a Diagnostic line so the WS
        // event, the persisted block, and the parent's next-turn view all carry
        // the real cause. Already-diagnostic results and non-subagent failures
        // pass through untouched.
        if (
          isError &&
          resultText &&
          /^(?:Error:\s*)?subagent run failed\b/.test(resultText) &&
          !resultText.includes("Diagnostic:")
        ) {
          let latest = null;
          for (const v of ctx.childTurnErrors?.values() ?? []) {
            if (!latest || v.ts > latest.ts) latest = v;
          }
          if (latest && (latest.message || latest.code)) {
            resultText += `\nDiagnostic: ${latest.code ? `[${latest.code}] ` : ""}${latest.message ?? ""}`;
            const firstText = resultBlocks?.find?.((b) => b.type === "text");
            if (firstText) firstText.text = resultText;
          }
        }
        // Fill the accumulated persistence block for this call.
        const acc = T.blocks.find((b) => b.id === callId);
        if (acc) {
          acc.result = resultText;
          acc.state = isError ? "error" : "done";
        }
        ctx.sendToViewers(sid, {
          type: "tool_end",
          toolCallId: callId,
          name: T.toolNames.get(callId) ?? undefined,
          result: resultText,
          isError,
        });
        // A resolved ask_user_question closes the pending card — answered,
        // cancelled, or failed, the tool result IS the card's summary
        // (add-user-questions). Every viewer converges on this tool_end.
        // Optional chaining: minimal/legacy contexts (e.g. unit-test fakes)
        // may predate the pending map — the ask path then no-ops.
        if (
          sid &&
          (T.toolNames.get(callId) === "ask_user_question" ||
            ctx.pendingQuestionBySession?.get(sid)?.toolCallId === callId)
        ) {
          ctx.pendingQuestionBySession?.delete(sid);
        }
        if (isError) markCredentialStaleOn401(ctx, T.toolNames.get(callId), resultText);
        break;
      }
      case "turn/end": {
        // An errored turn must never end silently. LLM failures are captured
        // earlier (assistant/chunk finish → dshTurnError) and replayed here;
        // other failures — e.g. the dsh session-log id collision after a child
        // restart — arrive ONLY on turn/end itself, and without this fallback
        // the client sees the turn end with no output and no explanation.
        const reason = ev.data?.reason;
        if (reason?.kind === "error") {
          const message = T.error || reason.error?.message || "The agent turn failed";
          ctx.sendToViewers(sid, { type: "error", message });
        }
        T.error = null;
        break;
      }
      case "todo/write": {
        // The agent's plan — a WHOLE-LIST snapshot (dsh-tool-todo replaces the
        // list on every call; last write wins). Cached per dsh session for the
        // rehydration push and broadcast to every web client. Deliberately NOT
        // cleared on turn boundaries: the plan outlives the turn that wrote it,
        // and only a new/loaded session resets it (agent-session.js / ws.js).
        const plan = normalizePlan(ev.data?.todos);
        if (!plan) {
          if (process.env.DSH_DEBUG) console.debug("[dsh] todo/write without a todos list; ignored");
          break;
        }
        if (sid) {
          ctx.planBySession.set(sid, plan);
          // Scoped delivery (per-session D4): another session's plan must not
          // clobber the plan of whatever this client is viewing.
          ctx.sendToViewers(sid, { type: "todos", todos: plan.todos, counts: plan.counts });
        }
        break;
      }
      case "permission/preset": {
        // The session's permission preset changed (a live switch via the
        // strip, or the initial pin when a fresh session publishes). Keying on
        // the preset event — not the sandbox/approval knob events — because
        // the preset name is the user-facing truth; unmatched knob
        // combinations surface as `custom` on the roster read path instead.
        const preset = ev.data?.preset || null;
        if (preset && preset !== ctx.currentPermission) {
          ctx.currentPermission = preset;
          ctx.broadcast({ type: "current_permission", name: preset });
        }
        break;
      }
      default:
        if (process.env.DSH_DEBUG) console.debug("[dsh] unmapped event:", ev.type);
        break;
    }
  };
}
