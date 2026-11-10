// WebSocket layer: the upgrade gate (same forward-auth identity check as
// HTTP) and the connection handler with the full client message switch
// (prompt dispatch, models, agents, skills, cron, sessions).

import * as chatHistory from "../chat-history.js";
import * as cron from "../cron.js";
import * as catalog from "../catalog.js";
import * as skills from "./skills.js";
import { chatPromptWithMemory, chatMemoryBlockFor } from "@finddatatechnology/yongyi-client";
import { getClusterDatabase } from "./routes/clusters-db.js";
import { userFromHeaders, mpUserFromToken, normalizeSsoEmail, withRoles } from "./auth.js";

// Identity for a WS upgrade, logto mode: the browser's session cookie first,
// then the mini program's platform Bearer token (openspec:
// miniprogram-auth) — the same second door the HTTP gate admits, fixed at
// upgrade time like every other identity source.
const logtoUser = (ctx, req) =>
  ctx.logtoAuth?.userFromCookie(req.headers.cookie) || mpUserFromToken(ctx, req);

// Demo prompt budget (openspec: mp-demo-mode). The cell learns "demo" from
// the identity the gateway injects (x-forwarded-groups → ws.user.groups), and
// counts turns for its own process lifetime: the gateway reaps a demo cell —
// and deletes its data — shortly after idle, so the counter resets with it.
// Account users pass through untouched. `everyone` (openspec:
// mp-demo-sandbox) counts EVERY identity — the accountless demo pod applies
// one budget per WS CONNECTION, so each visitor gets their own allowance.
export function createDemoBudget(limit, { everyone = false } = {}) {
  let used = 0;
  return {
    take(user) {
      if (!everyone && !user?.groups?.includes?.("demo")) return true;
      if (used >= limit) return false;
      used += 1;
      return true;
    },
    // Remaining budget after usage, or null when this budget does not apply
    // to the identity at all (non-demo users on the per-cell shape). Powers
    // the user echo's budgetLeft (add-mp-demo-quota-end).
    remaining(user) {
      if (!everyone && !user?.groups?.includes?.("demo")) return null;
      return Math.max(0, limit - used);
    },
  };
}

// The code field is the machine-readable quota shape (add-mp-demo-quota-end):
// the two shapes recover differently — bind to upgrade vs reconnect to reset.
export const DEMO_LIMIT_REPLY = {
  type: "error",
  code: "demo_limit",
  message: "体验额度已用完。在登录页输入绑定码，绑定你的平台账号即可解锁完整功能。",
};

export const SANDBOX_LIMIT_REPLY = {
  type: "error",
  code: "sandbox_limit",
  message: "演示额度已用完（每次连接 20 条）。断开重连可继续体验。",
};

export function authorizeUpgrade(ctx, req) {
  return ctx.authMode === "forward_auth"
    ? Boolean(userFromHeaders(req.headers, ctx.headerTrust) ?? mpUserFromToken(ctx, req))
    : ctx.authMode === "logto"
      ? Boolean(logtoUser(ctx, req))
      : true;
}

export function userForConnection(ctx, req) {
  return ctx.authMode === "forward_auth"
    ? (userFromHeaders(req.headers, ctx.headerTrust) ?? mpUserFromToken(ctx, req))
    : ctx.authMode === "logto"
      ? logtoUser(ctx, req)
      : null;
}

export function attachWebSocket(ctx) {
  // noServer + manual handleUpgrade so WS upgrades pass the same forward-auth
  // gate as HTTP requests (missing identity ⇒ handshake rejected with 401).
  const demoLimit = Number(process.env.MP_DEMO_MSG_LIMIT || 20);
  const demoBudget = createDemoBudget(demoLimit);
  // One guard for both demo shapes: the gateway path checks the shared
  // per-cell budget against the identity's demo group; the sandbox pod gives
  // EVERY connection its own budget (openspec: mp-demo-sandbox).
  const takeBudget = (ws) =>
    ctx.DEMO_SANDBOX ? ws.sandboxBudget.take(null) : demoBudget.take(ws.user);
  const budgetReply = () => (ctx.DEMO_SANDBOX ? SANDBOX_LIMIT_REPLY : DEMO_LIMIT_REPLY);
  // budgetLeft rides the accepted prompt's echo (add-mp-demo-quota-end): the
  // remaining count AFTER this prompt, present only when a budget applies to
  // the connection. Absent field ⇒ no budget (bound accounts).
  const budgetLeftField = (ws) => {
    const left = ctx.DEMO_SANDBOX ? ws.sandboxBudget.remaining(null) : demoBudget.remaining(ws.user);
    return left === null ? {} : { budgetLeft: left };
  };

  // First-use readiness gate (fix-external-team-chat-lane B6): the runtime
// answers "Agent is still initializing" while it is still coming up — the
// walkthrough hit it three times in a row on a freshly installed persona,
// because a background roster sync restarts the child (dsh-profile logs
// "runtime restarted for 63 catalog agent preset(s)") right when the visitor
// typed. Waiting BEFORE dispatch is the fix that works: a prompt dispatched
// into a restarting runtime is lost, while a prompt dispatched after
// readiness lands normally. Bounded wait; over the budget the honest error
// stands.
const FIRST_USE_READY_WAIT_MS = 120_000;
const FIRST_USE_READY_POLL_MS = 1_000;

function firstUseWaitMs() {
  const n = Number(process.env.CHAT_FIRST_USE_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : FIRST_USE_READY_WAIT_MS;
}

// True when the runtime is up (or the deployment has no runtime at all —
// then the caller's own guard decides).
function runtimeReady(ctx) {
  return ctx.dshBridge?.isReady?.() !== false;
}

async function waitForRuntimeReady(ctx, { waitMs = firstUseWaitMs() } = {}) {
  if (runtimeReady(ctx)) return true;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, FIRST_USE_READY_POLL_MS));
    if (runtimeReady(ctx)) return true;
  }
  return false;
}

// ── Dispatch helpers (concurrent-chat-sessions) ───────────────────────────
  // A session is busy for a NEW prompt when its own turn is open or it already
  // has a prompt queued behind another session's turn. Another session's open
  // turn is deliberately NOT busy here — that prompt is queued by the
  // dispatcher, which is the whole point of the change.
  const isBusyFor = (sid) => ctx.isStreamingFor(sid) || (ctx.isQueuedFor?.(sid) ?? false);
  const busyMessage = (sid) =>
    ctx.isQueuedFor?.(sid) ? "This chat already has a message waiting in the queue" : "The agent is still responding";

  // Minimal contexts (unit fakes, tooling) may attach the WS layer without the
  // dispatcher; degrade to running the prompt directly. The real composition
  // root always attaches attachTurnDispatch (server.js), so production never
  // takes this branch — it exists so a fake ctx need not model the queue.
  const dispatchOrRun = (params) => {
    if (typeof ctx.dispatchTurn === "function") return ctx.dispatchTurn(params);
    ctx.setStreaming(params.sessionId, true);
    params.onAccepted?.();
    Promise.resolve(params.run(params.sessionId)).catch((err) =>
      console.error("[ws] prompt run failed:", err?.message || err),
    );
    return { accepted: true, dispatched: true, queued: false };
  };

  // Demo budget consumption moved to acceptance (queued OR dispatched), so the
  // pre-flight only asks "would this be allowed", and the take happens in the
  // dispatcher's onAccepted.
  const budgetAllows = (ws) => {
    const left = ctx.DEMO_SANDBOX ? ws.sandboxBudget.remaining(null) : demoBudget.remaining(ws.user);
    return left === null || left > 0;
  };

  // The pre-await guard set above is a speculative reservation: it must be
  // released when the prompt never reaches the dispatcher (beginTurnFor threw,
  // or a fresh session was resolved — that session was never marked).
  const releaseSpeculativeGuard = (hint, target) => {
    if (!hint || hint === target) return;
    const T = ctx.turnStateBySession.get(hint);
    if (T?.isStreaming) T.isStreaming = false;
  };

  // A refusal happens after acceptance checks (queue full, or a racing prompt
  // that slipped in between the guard and the dispatch). Surface it the same
  // way the old guard did — as a plain error on this connection.
  const reportDispatchRefusal = (receipt, target, ws) => {
    if (receipt.accepted) return;
    if (receipt.reason === "queue_full") {
      ws.send(JSON.stringify({ type: "error", code: "queue_full", message: "Too many chats are waiting to run; try again shortly" }));
      return;
    }
    if (receipt.reason === "session_busy") {
      ws.send(JSON.stringify({ type: "error", message: busyMessage(target) }));
    }
  };
  ctx.server.on("upgrade", (req, socket, head) => {
    if (!authorizeUpgrade(ctx, req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    ctx.wss.handleUpgrade(req, socket, head, (ws) => ctx.wss.emit("connection", ws, req));
  });

// ── WebSocket handling ───────────────────────────────────────────────────────

const sendIfOpen = (ws, payload) => {
  if (ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
};

// Opening-recall echo (add-memory-visible-ux): on session open, echo the
// owner's digest (empty-query form — recent handoffs/L2/notes) to THIS
// session's viewers as a read-only side channel. The prompt-injection contract
// is untouched: this is display-only, fire-and-forget, degrade-open (no block /
// unavailable / kill switch ⇒ no event, open path byte-identical).
function sendMemoryRecall(ctx, ws, ownerEmail, sessionId) {
  if (process.env.CELL_MEMORY_RECALL_UI === "0") return;
  if (!ownerEmail) return;
  void chatMemoryBlockFor(ownerEmail, "", process.env)
    .then(({ block }) => {
      if (!block || !String(block).trim()) return;
      if (ws.viewedSession !== sessionId) return; // user moved on while reading
      ctx.sendToViewers(sessionId, { type: "memory_recall", sessionId, block });
    })
    .catch((err) => console.warn(`[memory-recall] echo skipped: ${err?.message || err}`));
}

// Windowed transcript for `session_loaded` (openspec: polish-web-surfaces,
// web-chat-server): only the tail window rides the first frame, plus the counts
// the client pages backwards with. Falls back to the switch result's messages
// when the session has no mirrored rows yet (paging then disabled — nothing
// older exists on disk).
const windowTranscript = async (result) => {
  const win = await chatHistory
    .getSessionWindow(result.id, { fallbackMessages: result.messages, fallbackTitle: result.title })
    .catch(() => null);
  return {
    title: win?.title ?? result.title,
    messages: win?.messages ?? result.messages ?? [],
    totalTurns: win?.totalTurns ?? (result.messages ?? []).length,
    hasMore: win?.hasMore ?? false,
  };
};

const syncPermissionState = async (ws) => {
  const { options, current } = await ctx.getPermissionPresets();
  sendIfOpen(ws, { type: "permissions", options, current });
};

// Prompt-implies-switch (add-session-ownership design D2). Resolve the session
// this connection's prompt belongs to, point the runtime at it (dsh persists
// sessions by id, so the turn resumes that session's context), and record the
// turn origin for the assistant mirror + event routing. A connection with no
// entitled view (welcome state, or its viewed row vanished) mints a fresh
// session of its own. The runtime still executes one turn at a time — this
// fixes attribution, not concurrency.
const beginTurnFor = async (ws) => {
  let target = ws.viewedSession;
  if (target) {
    const access = chatHistory.accessSession(ws.user, target, {
      authEnabled: ctx.authEnabled,
      isAdmin: ctx.isAdminUser?.(ws.user),
    });
    if (!access.ok) target = null;
  }
  if (!target) target = await ctx.startNewSession(ws);
  if (chatHistory.currentSessionId() !== target) {
    ctx.session.sessionManager.setSessionId(target);
    ctx.sessionVersion = (ctx.sessionVersion || 0) + 1;
  }
  ws.viewedSession = target;
  // Per-session turn state (D4): the web machinery keys everything by this
  // session; registering it here is also what routes its later notifications
  // to the web path after the session manager moves on.
  ctx.webTurnSessions.add(target);
  const T = ctx.turnStateFor(target);
  T.startedAt = Date.now(); // usage telemetry's duration anchor (set at dispatch truth)
  T.origin = {
    user: ctx.authEnabled ? ws.user?.email ?? null : null,
    sessionId: target,
  };
  // Session tool gates (live-runtime-control): re-assert the target session's
  // enabled gates to the child each turn. The child's gate map is per-child
  // state, so this heals a bridge restart and costs one tiny fire-and-forget
  // RPC per turn, only for sessions that enabled a gated server (default
  // closed needs no assertion — the child composes gates closed).
  const gates = ctx.sessionToolGates?.get(target);
  if (gates?.size && ctx.dshBridge?.hasLiveMethod?.("tools/set")) {
    for (const [server, enabled] of gates) {
      ctx.dshBridge.setToolGate({ sessionId: target, server, enabled }).catch(() => {});
    }
  }
  return target;
};

// Live-control flags (live-runtime-control): which custom bridge RPCs this
// child answers. Clients key affordances off them (stream-safe model selector,
// web-search toggle chip); the server's own switch paths degrade off the same
// source. Carried on every `models` message so a client connect/reconnect
// always has the current picture.
const liveControl = () =>
  ctx.liveControlFlags
    ? ctx.liveControlFlags()
    : { modelSet: false, cancel: false, toolGate: false };

// Sync a client that connected mid-boot with everything the normal connect
// path sends, once the dsh agent is live (the "ready" broadcast's payload).
const syncReadyClient = async (ws) => {
  const version = ctx.sessionVersion;
  if (!sendIfOpen(ws, { type: "ready" })) return;
  if (!sendIfOpen(ws, { type: "current_model", id: ctx.runtimeModel?.id || ctx.session?.model?.id || null, effort: ctx.currentEffort })) return;
  if (!sendIfOpen(ws, { type: "current_agent", id: ctx.currentAgentId })) return;
  if (!sendIfOpen(ws, { type: "agents", agents: ctx.switchableAgents(ws.user) })) return;
  if (ws.identity) ctx.sendUserBindings?.(ws, ws.identity.email);

  const models = await ctx.getAvailableModels();
  if (!sendIfOpen(ws, { type: "models", models, live: liveControl() })) return;
  if (!sendIfOpen(ws, { type: "current_preset", id: ctx.currentPreset })) return;
  // Permission state: the roster arrives on the client's list_permissions
  // request (bridge round-trip), but the current value is pushed here so a
  // late-connecting client immediately agrees with any switch another client
  // already made.
  if (ctx.currentPermission) sendIfOpen(ws, { type: "current_permission", name: ctx.currentPermission });
  await syncPermissionState(ws);
  if (ws.readyState !== ws.OPEN) return;
  // A mid-boot connect initialized its view against a runtime that had no
  // session yet; now that one exists, adopt it when entitled (auth-off always
  // is) so turn routing includes this connection (add-session-ownership).
  if (!ws.viewedSession) {
    const liveId = chatHistory.currentSessionId();
    if (
      liveId &&
      chatHistory.accessSession(ws.user, liveId, {
        authEnabled: ctx.authEnabled,
        isAdmin: ctx.isAdminUser?.(ws.user),
      }).ok
    ) {
      ws.viewedSession = liveId;
    }
  }
  // The live plan (add-plan-progress-panel): pushed after a mid-boot connect
  // completes so the client agrees with the running session before any turn.
  // Scoped like the connect path (add-session-ownership): the plan belongs to
  // the session this connection is entitled to view.
  if (!sendIfOpen(ws, ctx.planMessage(ws.viewedSession ?? ctx.dshSessionId))) return;
  // A pending user-question ask (add-user-questions): rehydrates the card for
  // a client that connected/reconnected while the ask waits. No empty form —
  // nothing is sent when no ask is pending.
  {
    // Optional chaining: contexts that predate the question sync (minimal
    // unit fakes) simply skip it.
    const question = ctx.questionMessage?.(ws.viewedSession ?? ctx.dshSessionId);
    if (question && !sendIfOpen(ws, question)) return;
  }

  const sessionRows = await chatHistory.listSessions(ctx.sessionScopeFor(ws));
  const sessions = ctx.withTurnStatus?.(sessionRows) ?? sessionRows;
  if (version !== ctx.sessionVersion) return;
  sendIfOpen(ws, {
    type: "sessions",
    sessions,
    current: ws.viewedSession ?? (ctx.authEnabled ? null : chatHistory.currentSessionId()),
  });
};

ctx.wss.on("connection", (ws, req) => {
  // Identity is fixed at upgrade time (v1 ceiling: no re-auth mid-connection).
  // Business roles ride the same fixed identity (role-system): assignment is
  // resolved once here, from the gateway's signed headers or the local store.
  ws.user = withRoles(ctx, userForConnection(ctx, req));
  // The optional-SSO overlay's identity is normalized like req.ssoUser (auth
  // boundary, server/auth.js): personal bindings key on the lowercase form.
  ws.identity = ctx.authEnabled
    ? ws.user
    : ctx.ssoEnabled
      ? normalizeSsoEmail(userFromHeaders(req.headers, ctx.headerTrust))
      : null;
  // Per-connection view (add-session-ownership): the session this client is
  // viewing. Initialized to the deployment's live session when this user is
  // entitled to it (auth-off is always entitled — single-user contract);
  // otherwise null: the client renders the welcome state and its first prompt
  // mints a session of its own (prompt-implies-switch below).
  {
    const liveId = chatHistory.currentSessionId();
    ws.viewedSession =
      !liveId ||
      chatHistory.accessSession(ws.user, liveId, {
        authEnabled: ctx.authEnabled,
        isAdmin: ctx.isAdminUser?.(ws.user),
      }).ok
        ? liveId
        : null;
  }
  // Sandbox pod: this connection's own prompt allowance (fresh per reconnect).
  if (ctx.DEMO_SANDBOX) ws.sandboxBudget = createDemoBudget(demoLimit, { everyone: true });
  ctx.clients.add(ws);
  console.log(`Client connected (${ctx.clients.size} total)`);

  // Mid-boot connections learn the agent is still initializing; the ready
  // broadcast re-syncs them with models/sessions once the dsh agent is live.
  if (!ctx.ready.dsh) ws.send(JSON.stringify({ type: "initializing" }));
  // Tell the client which model is currently active so the dropdown can sync.
  const currentModelId = ctx.runtimeModel?.id || ctx.session?.model?.id || null;
  ws.send(JSON.stringify({ type: "current_model", id: currentModelId, effort: ctx.currentEffort }));
  // Sync the agent switcher: active catalog agent + switchable agent list.
  ws.send(JSON.stringify({ type: "current_agent", id: ctx.currentAgentId }));
  ws.send(JSON.stringify({ type: "agents", agents: ctx.switchableAgents(ws.user) }));
  if (ws.identity) ctx.sendUserBindings?.(ws, ws.identity.email);
  // Sync the agent-mode selection so the welcome picker can mark it.
  ws.send(JSON.stringify({ type: "current_preset", id: ctx.currentPreset }));
  // The live plan for the current session (add-plan-progress-panel). Sent
  // unconditionally — a session with no plan sends the empty list, which the
  // client treats as "hide the surface" rather than as a stale snapshot. A
  // connection not entitled to the live session gets the empty plan of its own
  // (null) view instead of another user's plan (add-session-ownership).
  ws.send(JSON.stringify(ctx.planMessage(ws.viewedSession ?? ctx.dshSessionId)));
  // A pending user-question ask for the viewed session (add-user-questions):
  // sent only when one is waiting — a reconnect mid-ask must restore the card.
  {
    const question = ctx.questionMessage?.(ws.viewedSession ?? ctx.dshSessionId);
    if (question) ws.send(JSON.stringify(question));
  }
  if (ctx.ready.dsh) {
    void syncPermissionState(ws).catch((e) =>
      console.warn(`[chat-history] permission sync on connect failed: ${e.message}`)
    );
  }
  // Send the chat session list + current session so the sidebar syncs on
  // connect — scoped to this connection's user, with `current` naming THIS
  // connection's viewed session (add-session-ownership).
  if (ctx.session) {
    const version = ctx.sessionVersion;
    chatHistory
      .listSessions(ctx.sessionScopeFor(ws))
      .then((sessions) => {
        if (version !== ctx.sessionVersion) return;
        sendIfOpen(ws, {
          type: "sessions",
          sessions: ctx.withTurnStatus?.(sessions) ?? sessions,
          current: ws.viewedSession ?? (ctx.authEnabled ? null : chatHistory.currentSessionId()),
        });
      })
      .catch((e) => console.error("[chat-history] list on connect failed:", e.message));
  }
  // Send initial dashboard state on connect
  ws.send(JSON.stringify({ type: "dashboard_update", state: cron.getDashboardState() }));


  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    switch (data.type) {
      case "answer_question": {
        // Answer or cancel the session's pending user-question ask
        // (add-user-questions). Only a viewer of the owning session may
        // answer; first-wins is enforced by the runtime (an ask already
        // resolved there answers {accepted:false} and this client converges on
        // the ask's own tool_end). Bot asks never appear here — they answer in
        // their own channel (server/bots.js).
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        const target = ws.viewedSession ?? ctx.dshSessionId;
        const pending = target ? ctx.pendingQuestionBySession.get(target) : null;
        if (!pending || data.askId !== pending.askId) {
          ws.send(
            JSON.stringify({ type: "answer_question_error", message: "No pending question for this session" })
          );
          break;
        }
        try {
          const receipt =
            data.cancelled === true
              ? await ctx.dshBridge.answerUserQuestion({ sessionId: target, askId: data.askId, cancelled: true })
              : await ctx.dshBridge.answerUserQuestion({
                  sessionId: target,
                  askId: data.askId,
                  answers: Array.isArray(data.answers) ? data.answers : [],
                });
          // accepted:false = another surface answered first; the tool_end
          // broadcast resolves this client's card — nothing to report.
          if (receipt?.accepted === false && process.env.DSH_DEBUG) {
            console.debug("[dsh] answer_question raced a resolved ask; ignored");
          }
        } catch (err) {
          console.error(`[ws] answer_question failed: ${err.message}`);
          ws.send(JSON.stringify({ type: "error", message: `Answer failed: ${err.message}` }));
        }
        break;
      }

      case "prompt": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        const text = data.text?.trim();
        if (!text) return;

        // Parse a leading slash-command (/skill, /model, /new, …) if present.
        const cmd = skills.parseCommand(text);

        if (cmd && cmd.command === "skill") {
          // Per-session guard (D4): only the TARGET session's open turn blocks
          // this prompt — another session may legitimately be streaming. A
          // queued prompt counts as busy too (concurrent-chat-sessions).
          const skillHint = ws.viewedSession || null;
          if (skillHint && isBusyFor(skillHint)) {
            ws.send(JSON.stringify({ type: "error", message: busyMessage(skillHint) }));
            break;
          }
          if (!budgetAllows(ws)) {
            ws.send(JSON.stringify(budgetReply()));
            break;
          }
          // Set the guard synchronously (before the first await) so a
          // concurrent prompt on the SAME session is rejected. The dispatcher
          // treats it as this caller's reservation, not as someone else's turn.
          if (skillHint) {
            const T = ctx.turnStateFor(skillHint);
            T.promptStopped = false;
            T.isStreaming = true;
            T.startedAt = Date.now();
          }
          let target;
          try {
            target = await beginTurnFor(ws);
          } catch (err) {
            releaseSpeculativeGuard(skillHint, null);
            ws.send(JSON.stringify({ type: "error", message: err.message }));
            break;
          }
          releaseSpeculativeGuard(skillHint, target);
          const skillRun = async (sid) => {
            try {
              // Skill invocation: emit a skill_use block and suppress the raw
              // /skill:... text from being echoed as a normal user message.
              ctx.sendToViewers(sid, { type: "skill_use", name: cmd.name, args: cmd.args });
              // Mirror the user's skill invocation into the SQLite project
              // database (at dispatch — a cancelled queued prompt never lands).
              chatHistory.recordMessage(sid, "user", text, undefined, ctx.turnStateFor(sid).origin?.user ?? null);

              // Manually expand the skill content and send that to the agent.
              // This does not rely on session.prompt() expanding slash commands.
              // Scan the skills/ dir (same dir the skill-filesystem plugin's
              // customSkillDirs points at, Task 5.3).
              const fileSkills = skills.getFileSkills();
              const skill = fileSkills.find((s) => s.name === cmd.name);
              let promptText = text;
              if (skill) {
                promptText = await skills.expandSkillContent(skill, cmd.args);
              }
              // Expand @doc:<id> attachment references (design D4).
              promptText = await skills.expandDocRefs(ctx, promptText);
              // Explicit sid (concurrent-chat-sessions D6): the target was
              // resolved before this turn was queued, so a session switch while
              // the prompt waited can never re-attribute it.
              await ctx.session.prompt(promptText, sid);
            } catch (err) {
              const T = ctx.turnStateBySession.get(sid);
              const stopped = T?.promptStopped === true;
              if (T) T.promptStopped = false;
              if (!stopped) {
                console.error("Agent error:", err.message);
                ctx.sendToViewers(sid, { type: "error", message: err.message });
              }
              ctx.finishTurn(undefined, sid);
            }
          };
          const receipt = dispatchOrRun({
            sessionId: target,
            text,
            run: skillRun,
            ws,
            reserved: Boolean(skillHint) && skillHint === target,
            onAccepted: () => takeBudget(ws),
          });
          reportDispatchRefusal(receipt, target, ws);
        } else if (cmd && cmd.command === "model") {
          await ctx.handleModelCommand(cmd.args, ws);
        } else if (cmd && cmd.command === "new") {
          await ctx.handleNewCommand(ws);
        } else if (cmd && (cmd.command === "clear" || cmd.command === "help")) {
          // Client-handled commands; the UI should not forward them. Ignore.
          return;
        } else {
          // Normal prompt (includes unknown "/…" commands that fall through):
          // echo the user message and forward. Per-session guard (D4): only
          // the TARGET session's open turn blocks this prompt; a queued prompt
          // counts as busy too.
          const promptHint = ws.viewedSession || null;
          if (promptHint && isBusyFor(promptHint)) {
            ws.send(JSON.stringify({ type: "error", message: busyMessage(promptHint) }));
            break;
          }
          // A chat-mode catalog agent forks to its OpenAI-compatible endpoint only
          // while the deployment has no local persona preset for it; with a preset
          // (vertical packs) the same agent runs on the local runtime so it keeps
          // its tools, MCP servers and session history.
          const entry = ctx.remoteChatEntryFor(ctx.currentAgentId);
          if (ctx.currentAgentId !== "local" && !entry && !catalog.getAgentEntry(ctx.currentAgentId)) {
            ws.send(JSON.stringify({ type: "error", message: `Unknown agent: ${ctx.currentAgentId}` }));
            break;
          }
          if (!budgetAllows(ws)) {
            ws.send(JSON.stringify(budgetReply()));
            break;
          }

          // Set the guard synchronously (before the first await) so a
          // concurrent prompt on the SAME session is rejected. The dispatcher
          // reads it as this caller's reservation, not as someone else's turn.
          if (promptHint) {
            const T = ctx.turnStateFor(promptHint);
            T.promptStopped = false;
            T.isStreaming = true;
            T.startedAt = Date.now();
          }
          let target;
          try {
            target = await beginTurnFor(ws);
          } catch (err) {
            releaseSpeculativeGuard(promptHint, null);
            ws.send(JSON.stringify({ type: "error", message: err.message }));
            break;
          }
          releaseSpeculativeGuard(promptHint, target);
          const run = async (sid) => {
            try {
              ctx.sendToViewers(sid, { type: "user", text, ...budgetLeftField(ws) });

              if (entry) {
                // Remote-agent fork: expand refs before streaming from the
                // entry's own transport instead of the local session — an
                // OpenAI-compatible endpoint (chat mode) or the A2A gateway
                // route (a2a mode, add-a2a-agent-serving 5.3).
                const promptText = await skills.expandDocRefs(ctx, text);
                await (entry.mode === "a2a"
                  ? ctx.streamA2aChat(entry, promptText, sid)
                  : ctx.streamRemoteChat(entry, promptText, sid));
              } else {
                // Mirror the user prompt into the SQLite project database at
                // DISPATCH (not acceptance): a cancelled queued prompt leaves
                // no history row. Stamped with the submitting connection's user.
                chatHistory.recordMessage(sid, "user", text, undefined, ctx.turnStateFor(sid).origin?.user ?? null);
                // Expand @doc:<id> attachment references into the document content the
                // agent sees (design D4); the user message above keeps the raw refs.
                const promptWithDocs = await skills.expandDocRefs(ctx, text);
                // Chat memory ladder (add-chat-memory-injection): one digest read
                // from the owner's memory root (project "default"), degrade-open —
                // the same shape the cron hook ① uses for cluster turns. The
                // injected block lives only in the outgoing prompt; the history
                // row above keeps the raw text, same contract as @doc expansion.
                const promptOut = await chatPromptWithMemory(ws.identity?.email, promptWithDocs);
                // Chat-lane team context (fix-external-team-chat-lane B1): the
                // live persona may be a fleet post — give it the trimmed roster
                // (team identity + members + dispatchable targets) so it can
                // name teammates and dispatch to them by title. Attribution is
                // server-side; no team ⇒ null ⇒ the prompt is byte-identical.
                const teamContext = ctx.resolveFleetChatContext?.(ctx.currentPreset) ?? null;
                const finalPrompt = teamContext ? `${teamContext}\n\n${promptOut}` : promptOut;
                // First-use wait (fix-external-team-chat-lane B6): switching to
                // a pack persona restarts the runtime, and a prompt that lands
                // while the child is still coming up used to fail the turn
                // with "Agent is still initializing" — the walkthrough saw it
                // three times in a row on a freshly installed persona. Wait
                // for readiness (bounded) and retry ONCE; a second failure
                // surfaces honestly.
                const ready = await waitForRuntimeReady(ctx);
                if (!ready) {
                  ctx.sendToViewers(sid, { type: "error", message: "Agent is still initializing" });
                  return;
                }
                try {
                  await ctx.session.prompt(finalPrompt, sid);
                } catch (err) {
                  // A restart that lands between the readiness check and the
                  // dispatch still costs the turn — retry ONCE after the
                  // runtime settles. A second failure surfaces honestly.
                  if (!/still initializing|runtime not ready/i.test(err?.message ?? "")) throw err;
                  await waitForRuntimeReady(ctx);
                  await ctx.session.prompt(finalPrompt, sid);
                }
              }
            } catch (err) {
              // An explicit stop cancelled the run; the resulting RPC rejection
              // is intentional, not an error to surface.
              const T = ctx.turnStateBySession.get(sid);
              const stopped = T?.promptStopped === true;
              if (T) T.promptStopped = false;
              if (!stopped) {
                console.error("Agent error:", err.message);
                ctx.sendToViewers(sid, { type: "error", message: err.message });
              }
              // Finish the turn (reset streaming, emit done, refresh sessions) so a
              // failed turn does not wedge the UI or block model-switch/new-session.
              ctx.finishTurn(undefined, sid);
            }
          };
          const receipt = dispatchOrRun({
            sessionId: target,
            text,
            run,
            ws,
            reserved: Boolean(promptHint) && promptHint === target,
            onAccepted: () => takeBudget(ws),
          });
          reportDispatchRefusal(receipt, target, ws);
        }
        break;
      }

      case "list_bindings": {
        if (!ws.identity) {
          ws.send(JSON.stringify({ type: "user_bindings", model: null, mcp: [] }));
          break;
        }
        ctx.sendUserBindings?.(ws, ws.identity.email);
        break;
      }

      case "list_models": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        const models = await ctx.getAvailableModels();
        ws.send(JSON.stringify({ type: "models", models, live: liveControl() }));
        break;
      }

      case "stop_turn": {
        // Real stop (live-runtime-control): cancel the run in the child; the
        // aborted run's session.status idle notification finalizes the turn
        // (finishTurn → done), so the client's suppression clears through the
        // normal close. Without the live method, finalize immediately — the
        // client's local stop view stays the fallback and this done releases
        // its suppression honestly.
        // `id` lets a queued prompt stop the session blocking it
        // (concurrent-chat-sessions): the requester may be viewing a DIFFERENT
        // session, so the explicit target still passes the ownership gate.
        let stopSid = ws.viewedSession || null;
        if (typeof data.id === "string" && data.id && data.id !== stopSid) {
          const access = chatHistory.accessSession(ws.user, data.id, {
            authEnabled: ctx.authEnabled,
            isAdmin: ctx.isAdminUser?.(ws.user),
          });
          if (!access.ok) {
            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  access.reason === "forbidden"
                    ? "You do not have access to this session"
                    : `session ${data.id} not found`,
              }),
            );
            break;
          }
          stopSid = data.id;
        }
        if (!ctx.ready.dsh || !stopSid) break;
        // Queued prompt (concurrent-chat-sessions): stop means "withdraw it
        // before it ever reaches the runtime" — no cancel RPC, no done.
        if (ctx.isQueuedFor?.(stopSid)) {
          ctx.cancelQueued?.(stopSid);
          break;
        }
        if (!ctx.isStreamingFor(stopSid)) break;
        // A remote-agent fork owns its fetch, not the dsh child: abort it and
        // close the turn here (the child has no run to cancel for this id).
        const remoteAbort = ctx.activeRemoteTurnAbort;
        if (remoteAbort && remoteAbort.sessionId === stopSid) {
          remoteAbort.aborted = true;
          if (ctx.activeRemoteTurnAbort === remoteAbort) ctx.activeRemoteTurnAbort = null;
          ctx.turnStateFor(stopSid).promptStopped = true;
          ctx.finishTurn("aborted", stopSid);
          remoteAbort.abort();
          break;
        }
        if (ctx.dshBridge?.hasLiveMethod?.("session/cancel")) {
          // The abort makes the dispatching prompt's promise reject — that
          // rejection is intentional, not a failure to surface.
          ctx.turnStateFor(stopSid).promptStopped = true;
          ctx.dshBridge.cancelSession(stopSid).catch((e) =>
            console.warn("[dsh] live cancel on stop failed:", e?.message || e),
          );
        } else {
          ctx.finishTurn("aborted", stopSid);
        }
        break;
      }

      case "set_tool_gate": {
        // Per-session MCP server gate (live-runtime-control): default-closed
        // servers (websearch) the user flips per conversation. The host keeps
        // the durable intent; the child enforces per tool call.
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        if (!ctx.dshBridge?.hasLiveMethod?.("tools/set")) {
          ws.send(JSON.stringify({ type: "error", message: "Tool gating is unavailable on this runtime" }));
          break;
        }
        const gateServer = typeof data.server === "string" && data.server ? data.server : "websearch";
        const gateEnabled = data.enabled === true;
        const gateSession = ws.viewedSession || chatHistory.currentSessionId();
        if (!gateSession) break;
        ctx.setSessionToolGate(gateSession, gateServer, gateEnabled);
        ctx.dshBridge
          .setToolGate({ sessionId: gateSession, server: gateServer, enabled: gateEnabled })
          .catch((e) => console.warn(`[dsh] tools/set for ${gateSession} failed:`, e?.message || e));
        ctx.sendToViewers(gateSession, {
          type: "tool_gate",
          sessionId: gateSession,
          server: gateServer,
          enabled: gateEnabled,
        });
        break;
      }

      case "set_model": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        // No run is open for a select-control switch, so a failure reaches the
        // client as an orphan error — it renders as a toast, which is the
        // right weight for a transient control action.
        const r = await ctx.switchModelTo(data.id);
        if (!r.ok && r.error) ws.send(JSON.stringify({ type: "error", message: r.error }));
        break;
      }

      case "set_effort": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        const r = await ctx.switchEffortTo(data.effort || null);
        if (!r.ok && r.error) ws.send(JSON.stringify({ type: "error", message: r.error }));
        break;
      }

      case "list_presets": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        const presets = await ctx.getAgentPresets();
        ws.send(JSON.stringify({ type: "presets", presets, current: ctx.currentPreset }));
        break;
      }

      case "set_preset": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        // Same contract as set_model: a failure is an orphan error → renders
        // as a toast, and the previous preset stays reported as current.
        const r = await ctx.switchPresetTo(data.id);
        if (!r.ok && r.error) ws.send(JSON.stringify({ type: "error", message: r.error }));
        break;
      }

      case "list_permissions": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        const { options, current } = await ctx.getPermissionPresets();
        ws.send(JSON.stringify({ type: "permissions", options, current }));
        break;
      }

      case "set_permission": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        // Live in-session switch — no restart, no pending window. A failure
        // (streaming guard, unknown name, missing acknowledgement for full
        // access, bridge error) is an orphan error → renders as a toast; the
        // previous preset stays reported as current.
        //
        // `acknowledge` comes from the client's risk dialog and is required by
        // the session layer for `danger-full-access` — the dialog is a UI
        // convention, so the flag has to ride the message itself.
        const r = await ctx.switchPermissionTo(data.name, { acknowledge: data.acknowledge === true });
        if (!r.ok && r.error) ws.send(JSON.stringify({ type: "error", message: r.error }));
        break;
      }

      case "list_plugins": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        // Read-only inventory of the profile's whitelisted dsh bundles
        // (add-dsh-plugin-supply). `available:false` means the roster is the
        // last known (or empty) snapshot — the Plugins section renders it
        // without erroring.
        const { available, bundles } = await ctx.getPluginBundles();
        ws.send(JSON.stringify({ type: "plugins", bundles, available }));
        break;
      }

      case "set_plugin_enabled": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        // Composition change: the child persists the bundle-layer selection
        // and either recomposes live (HMR) or the bridge restarts (sessions
        // resume by id). A failure (streaming guard, unknown bundle, version
        // gate, bridge error) is an orphan error → renders as a toast, and the
        // roster keeps its previous state.
        const r = await ctx.togglePluginBundle(data.id, data.enabled === true);
        if (!r.ok && r.error) ws.send(JSON.stringify({ type: "error", message: r.error }));
        break;
      }

      case "list_workspaces": {
        ws.send(JSON.stringify({ type: "workspaces", ...ctx.listWorkspaces() }));
        break;
      }

      case "set_workspace": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        const r = await ctx.switchWorkspaceTo(data.path);
        if (!r.ok && r.error) ws.send(JSON.stringify({ type: "error", message: r.error }));
        break;
      }

      case "list_agents": {
        ws.send(JSON.stringify({ type: "agents", agents: ctx.switchableAgents(ws.user) }));
        break;
      }

      case "set_agent": {
        ctx.switchAgentTo(data.id, ws);
        break;
      }

      case "list_skills": {
        const COMPUTER_USE_ENABLED = process.env.ENABLE_COMPUTER_USE === "true";
        const fileSkills = skills.getFileSkills()
          .filter((s) => {
            if (!COMPUTER_USE_ENABLED && s.name.startsWith("computer-")) {
              return false;
            }
            return true;
          })
          .map((s) => ({
            name: s.name,
            description: s.description,
          }));
        ws.send(JSON.stringify({ type: "skills", skills: fileSkills }));
        break;
      }

      case "cron_add": {
        try {
          // Cluster binding (agent-cluster-platform): same shapes the REST
          // bridge validates; the cluster's existence resolves where clusters
          // live (clusters.db) before the engine sees the ref.
          let clusterFields = null;
          if (data.clusterId !== undefined) {
            const cluster = getClusterDatabase().get(data.clusterId);
            if (!cluster) throw new Error(`cluster '${data.clusterId}' not found`);
            clusterFields = {
              clusterId: cluster.id,
              clusterName: cluster.name,
              agentCount: cluster.agents.length,
              executionPolicy: data.executionPolicy,
              targetAgents: data.targetAgents,
            };
          }
          const job = await cron.addJob({
            cron: data.cron,
            when: data.when,
            prompt: data.prompt,
            preset: data.preset,
            tz: data.tz,
            sessionTitle: data.sessionTitle,
            // add-cron-automation-parity: the two new schedule forms + cap.
            ...(data.delayMinutes !== undefined ? { delayMinutes: data.delayMinutes } : {}),
            ...(data.interval !== undefined ? { interval: data.interval } : {}),
            ...(data.maxRuns !== undefined ? { maxRuns: data.maxRuns } : {}),
            // add-web-project-container: the active web project, if any.
            ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
            ...(clusterFields ?? {}),
          });
          ws.send(JSON.stringify({ type: "cron_added", job }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "cron_error", action: "cron_add", message: err.message }));
        }
        break;
      }

      case "cron_update": {
        // In-place schedule edit (add-cron-automation-parity 2.1): id,
        // execution history and paused state survive; only the provided
        // fields change. Changing the schedule re-arms from the new form.
        try {
          const job = await cron.updateJob(data.jobId, {
            ...(data.cron !== undefined ? { cron: data.cron } : {}),
            ...(data.when !== undefined ? { when: data.when } : {}),
            ...(data.delayMinutes !== undefined ? { delayMinutes: data.delayMinutes } : {}),
            ...(data.interval !== undefined ? { interval: data.interval } : {}),
            ...(data.maxRuns !== undefined ? { maxRuns: data.maxRuns } : {}),
            ...(data.prompt !== undefined ? { prompt: data.prompt } : {}),
            ...(data.sessionTitle !== undefined ? { sessionTitle: data.sessionTitle } : {}),
            ...(data.tz !== undefined ? { tz: data.tz } : {}),
          });
          if (!job) throw new Error("job not found");
          ws.send(JSON.stringify({ type: "cron_updated", job }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "cron_error", action: "cron_update", message: err.message }));
        }
        break;
      }

      case "cron_remove": {
        try {
          const removed = await cron.removeJob(data.jobId);
          ws.send(JSON.stringify({ type: "cron_removed", jobId: data.jobId, success: removed }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "cron_pause": {
        try {
          const paused = await cron.pauseJob(data.jobId);
          ws.send(JSON.stringify({ type: "cron_paused", jobId: data.jobId, success: paused }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "cron_resume": {
        try {
          const resumed = await cron.resumeJob(data.jobId);
          ws.send(JSON.stringify({ type: "cron_resumed", jobId: data.jobId, success: resumed }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "cron_list": {
        ws.send(JSON.stringify({ type: "cron_jobs", jobs: cron.listJobs() }));
        break;
      }

      case "cron_run": {
        try {
          // runJobNow returns the engine's enqueue result: already-queued or
          // running executions are a no-op carrying the current state (re-run
          // never double-queues).
          const r = await cron.runJobNow(data.jobId);
          ws.send(JSON.stringify({
            type: "cron_run_started",
            jobId: data.jobId,
            success: r?.ok === true,
            ...(r?.state ? { state: r.state } : {}),
            ...(r?.already ? { already: true } : {}),
            ...(r?.error ? { message: r.error } : {}),
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "dashboard_state": {
        ws.send(JSON.stringify({ type: "dashboard_state", state: cron.getDashboardState() }));
        break;
      }

      case "list_sessions": {
        const version = ctx.sessionVersion;
        const sessionRows = await chatHistory.listSessions(ctx.sessionScopeFor(ws));
  const sessions = ctx.withTurnStatus?.(sessionRows) ?? sessionRows;
        if (version === ctx.sessionVersion) {
          ws.send(
            JSON.stringify({
              type: "sessions",
              sessions,
              current: ws.viewedSession ?? (ctx.authEnabled ? null : chatHistory.currentSessionId()),
            })
          );
        }
        break;
      }

      case "new_session": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        try {
          await ctx.startNewSession(ws);
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "switch_session": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        // Ownership gate (add-session-ownership): a session owned by another
        // non-admin user is refused before the runtime is touched — not just
        // hidden from the list.
        const access = chatHistory.accessSession(ws.user, data.id, {
          authEnabled: ctx.authEnabled,
          isAdmin: ctx.isAdminUser?.(ws.user),
        });
        if (!access.ok) {
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                access.reason === "forbidden"
                  ? "You do not have access to this session"
                  : `session ${data.id} not found`,
            })
          );
          break;
        }
        // Reconnect resync guard (add-reconnect-resync): a machine-initiated
        // re-sync (resync:true, sent by the WS hook's onOpen) must never
        // NAVIGATE the runtime. When a turn is in flight on a session other
        // than the one being re-synced, a normal switch would stop that run
        // (stopStreamingForSessionNavigation) — correct for a user's explicit
        // choice, destructive as a reconnect side effect. Serve the
        // transcript-only answer instead: nothing runs for the target, so
        // running is false and the client takes the plain replace branch.
        // Resync answers go to the REQUESTER only (ws.send): a resync is a
        // machine refresh of one connection — rebroadcasting to every viewer
        // of the session would clobber co-viewing pages' live state, and
        // refreshes carry no list-wide change worth a sessions broadcast.
        if (data.resync === true && !ctx.isStreamingFor(data.id)) {
          // Windowed read, with the live-session fallback preserved: getSession
          // still provides the in-memory messages for the not-yet-mirrored case.
          const sess = await chatHistory.getSession(data.id).catch(() => null);
          const win = await chatHistory
            .getSessionWindow(data.id, { fallbackMessages: sess?.messages, fallbackTitle: sess?.title })
            .catch(() => null);
          ws.viewedSession = data.id;
          sendIfOpen(ws, {
            type: "session_loaded",
            id: data.id,
            title: win?.title || "Chat",
            messages: win?.messages || [],
            totalTurns: win?.totalTurns ?? 0,
            hasMore: win?.hasMore ?? false,
            running: false,
            queued: ctx.queuedViewFor?.(data.id) ?? null,
          });
          sendIfOpen(ws, ctx.planMessage(data.id));
          {
            const question = ctx.questionMessage?.(data.id);
            if (question) sendIfOpen(ws, question);
          }
          sendMemoryRecall(ctx, ws, ws.identity?.email ?? null, data.id);
          break;
        }
        try {
          const result = await ctx.switchToSession(data.id);
          ws.viewedSession = result.id;
          if (data.resync === true) {
            // Same-session fast path (the common reconnect case): reply to
            // the requester only, with the turn-in-flight status and replay
            // log when one exists (add-reconnect-resync). No list broadcast —
            // a resync changes no session state the roster could observe.
            const running = ctx.isStreamingFor(result.id);
            const buf = ctx.turnBufferFor(result.id);
            const turnEvents =
              running && buf && !buf.overflow && buf.events.length > 0
                ? buf.events.map((e) => ({ ...e }))
                : undefined;
            const win = await windowTranscript(result);
            sendIfOpen(ws, {
              type: "session_loaded",
              id: result.id,
              title: win.title,
              messages: win.messages,
              totalTurns: win.totalTurns,
              hasMore: win.hasMore,
              running,
              ...(turnEvents ? { turnEvents } : {}),
              queued: ctx.queuedViewFor?.(result.id) ?? null,
            });
            sendIfOpen(ws, ctx.planMessage(result.id));
            {
              const question = ctx.questionMessage?.(result.id);
              if (question) sendIfOpen(ws, question);
            }
            // The session's tool-gate state (live-runtime-control): always
            // sent — the empty form is the default-closed chip position.
            sendIfOpen(ws, ctx.toolGateMessage(result.id));
            break;
          }
          // Reconnect resync payload (add-reconnect-resync): report whether a
          // turn is in flight for THIS session, and when it is, the replayable
          // event log so the client rebuilds the open turn. Fields are
          // additive — older clients ignore them and keep today's behavior.
          const running = ctx.isStreamingFor(result.id);
          const buf = ctx.turnBufferFor(result.id);
          const turnEvents =
            running && buf && !buf.overflow && buf.events.length > 0
              ? buf.events.map((e) => ({ ...e }))
              : undefined;
          // Per-viewer delivery: the requester (now viewing the target) plus
          // any other connection already viewing it. Foreign clients keep
          // their own view and their own transcript.
          const win = await windowTranscript(result);
          ctx.sendToViewers(result.id, {
            type: "session_loaded",
            id: result.id,
            title: win.title,
            messages: win.messages,
            totalTurns: win.totalTurns,
            hasMore: win.hasMore,
            running,
            ...(turnEvents ? { turnEvents } : {}),
            queued: ctx.queuedViewFor?.(result.id) ?? null,
          });
          // The target session's own plan (or the empty list). The client clears
          // the plan on session_loaded; this push is what restores it when the
          // user switches back to a session that had one (add-plan-progress-panel).
          ctx.sendToViewers(result.id, ctx.planMessage(result.id));
          // Same restore for a pending ask (add-user-questions): the client
          // drops its card on session_loaded, so a session whose ask is still
          // waiting needs the card re-pushed to its viewers.
          {
            const question = ctx.questionMessage?.(result.id);
            if (question) ctx.sendToViewers(result.id, question);
          }
          // Tool-gate restore (live-runtime-control): the client resets its
          // web-search chip on session_loaded; this push restates the session's
          // gate so the chip never shows the previous session's position.
          ctx.sendToViewers(result.id, ctx.toolGateMessage(result.id));
          sendMemoryRecall(ctx, ws, ws.identity?.email ?? null, result.id);
          ctx.sendToViewers(result.id, { type: "session_changed", id: result.id });
          void ctx.broadcastSessions();
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "load_earlier": {
        // Page backwards through a long transcript (openspec: polish-web-surfaces,
        // web-chat-server). Same ownership gate as switch_session; the page goes
        // to the REQUESTER only (paging is a per-viewer read, not a broadcast).
        const access = chatHistory.accessSession(ws.user, data.id, {
          authEnabled: ctx.authEnabled,
          isAdmin: ctx.isAdminUser?.(ws.user),
        });
        if (!access.ok) {
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                access.reason === "forbidden"
                  ? "You do not have access to this session"
                  : `session ${data.id} not found`,
            })
          );
          break;
        }
        try {
          const page = await chatHistory.getEarlierMessages(data.id, data.beforeSeq);
          sendIfOpen(ws, {
            type: "session_page",
            id: data.id,
            messages: page.messages,
            hasMore: page.hasMore,
          });
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "rename_session": {
        const access = chatHistory.accessSession(ws.user, data.id, {
          authEnabled: ctx.authEnabled,
          isAdmin: ctx.isAdminUser?.(ws.user),
        });
        if (!access.ok) {
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                access.reason === "forbidden"
                  ? "You do not have access to this session"
                  : `session ${data.id} not found`,
            })
          );
          break;
        }
        try {
          const title = chatHistory.setTitle(data.id, data.title);
          ctx.sendToViewers(data.id, { type: "session_renamed", id: data.id, title });
        } catch (err) {
          if (err?.code) {
            ws.send(JSON.stringify({ type: "rename_session_error", code: err.code, message: err.message }));
          } else {
            ws.send(JSON.stringify({ type: "error", message: err.message }));
          }
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    ctx.clients.delete(ws);
    console.log(`Client disconnected (${ctx.clients.size} total)`);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    ctx.clients.delete(ws);
  });
});

// Called by the composition root when the dsh agent finishes initializing:
// every connected client gets the ready event + the connect-time payloads.
ctx.onDshReady = () => {
  for (const ws of ctx.clients) void syncReadyClient(ws);
};
}
