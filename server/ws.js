// WebSocket layer: the upgrade gate (same forward-auth identity check as
// HTTP) and the connection handler with the full client message switch
// (prompt dispatch, models, agents, skills, cron, sessions).

import * as chatHistory from "../chat-history.js";
import * as cron from "../cron.js";
import * as catalog from "../catalog.js";
import * as skills from "./skills.js";
import { userFromHeaders, mpUserFromToken, normalizeSsoEmail } from "./auth.js";

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
    ? Boolean(userFromHeaders(req.headers, ctx.headerTrust))
    : ctx.authMode === "logto"
      ? Boolean(logtoUser(ctx, req))
      : true;
}

export function userForConnection(ctx, req) {
  return ctx.authMode === "forward_auth"
    ? userFromHeaders(req.headers, ctx.headerTrust)
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
  ctx.turnOrigin = {
    user: ctx.authEnabled ? ws.user?.email ?? null : null,
    sessionId: target,
  };
  return target;
};

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
  if (!sendIfOpen(ws, { type: "models", models })) return;
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

  const sessions = await chatHistory.listSessions(ctx.sessionScopeFor(ws));
  if (version !== ctx.sessionVersion) return;
  sendIfOpen(ws, {
    type: "sessions",
    sessions,
    current: ws.viewedSession ?? (ctx.authEnabled ? null : chatHistory.currentSessionId()),
  });
};

ctx.wss.on("connection", (ws, req) => {
  // Identity is fixed at upgrade time (v1 ceiling: no re-auth mid-connection).
  ws.user = userForConnection(ctx, req);
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
          sessions,
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
          if (ctx.isStreaming) {
            ws.send(JSON.stringify({ type: "error", message: "The agent is still responding" }));
            break;
          }
          if (!takeBudget(ws)) {
            ws.send(JSON.stringify(budgetReply()));
            break;
          }
          // Set in-flight synchronously (before the first await) so a concurrent
          // prompt is rejected. agent_start sets it again later (idempotent).
          // A stale navigation-stop marker means the old turn already settled;
          // this new turn must own its own errors.
          ctx.promptStoppedByNavigation = false;
          ctx.isStreaming = true;
          try {
            const target = await beginTurnFor(ws);
            // Skill invocation: emit a skill_use block and suppress the raw
            // /skill:... text from being echoed as a normal user message.
            ctx.sendToViewers(target, { type: "skill_use", name: cmd.name, args: cmd.args });
            // Mirror the user's skill invocation into the SQLite project database.
            chatHistory.recordMessage(target, "user", text, undefined, ctx.turnOrigin.user);

            // Manually expand the skill content and send that to the agent. This
            // does not rely on session.prompt() expanding slash commands.
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
            await ctx.session.prompt(promptText);
          } catch (err) {
            // The user navigated away and stopStreamingForSessionNavigation
            // closed the child; the resulting RPC rejection is intentional.
            const stoppedByNavigation = ctx.promptStoppedByNavigation;
            ctx.promptStoppedByNavigation = false;
            if (!stoppedByNavigation) {
              console.error("Agent error:", err.message);
              ctx.broadcast({ type: "error", message: err.message });
            }
            // Finish the turn (reset streaming, emit done, refresh sessions) so a
            // failed turn does not wedge the UI or block model-switch/new-session.
            ctx.finishTurn();
          }
        } else if (cmd && cmd.command === "model") {
          await ctx.handleModelCommand(cmd.args, ws);
        } else if (cmd && cmd.command === "new") {
          await ctx.handleNewCommand(ws);
        } else if (cmd && (cmd.command === "clear" || cmd.command === "help")) {
          // Client-handled commands; the UI should not forward them. Ignore.
          return;
        } else {
          // Normal prompt (includes unknown "/…" commands that fall through):
          // echo the user message and forward.
          if (ctx.isStreaming) {
            ws.send(JSON.stringify({ type: "error", message: "The agent is still responding" }));
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
          if (!takeBudget(ws)) {
            ws.send(JSON.stringify(budgetReply()));
            break;
          }

          // No steer mechanism through the bridge; reject concurrent prompts
          // host-side (Task 2.7) rather than queueing a second turn. Set the
          // guard before the first await so a concurrent prompt cannot enter.
          // Same stale-marker contract as the skill branch above.
          ctx.promptStoppedByNavigation = false;
          ctx.isStreaming = true;
          try {
            const target = await beginTurnFor(ws);
            ctx.sendToViewers(target, { type: "user", text, ...budgetLeftField(ws) });

            if (entry) {
              // Remote-agent fork: expand refs before streaming from the
              // entry's own transport instead of the local session — an
              // OpenAI-compatible endpoint (chat mode) or the A2A gateway
              // route (a2a mode, add-a2a-agent-serving 5.3).
              const promptText = await skills.expandDocRefs(ctx, text);
              await (entry.mode === "a2a" ? ctx.streamA2aChat(entry, promptText) : ctx.streamRemoteChat(entry, promptText));
            } else {
              // Mirror the user prompt into the SQLite project database,
              // stamped with the submitting connection's user.
              chatHistory.recordMessage(target, "user", text, undefined, ctx.turnOrigin.user);
              // Expand @doc:<id> attachment references into the document content the
              // agent sees (design D4); the user message above keeps the raw refs.
              const promptWithDocs = await skills.expandDocRefs(ctx, text);
              await ctx.session.prompt(promptWithDocs);
            }
          } catch (err) {
            // Intentional child shutdown for session navigation — not an error.
            const stoppedByNavigation = ctx.promptStoppedByNavigation;
            ctx.promptStoppedByNavigation = false;
            if (!stoppedByNavigation) {
              console.error("Agent error:", err.message);
              ctx.sendToViewers(ctx.turnOrigin?.sessionId ?? ctx.dshSessionId, {
                type: "error",
                message: err.message,
              });
            }
            // Finish the turn (reset streaming, emit done, refresh sessions) so a
            // failed turn does not wedge the UI or block model-switch/new-session.
            ctx.finishTurn();
          }
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
        ws.send(JSON.stringify({ type: "models", models }));
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
        // (streaming guard, unknown name, bridge error) is an orphan error →
        // renders as a toast; the previous preset stays reported as current.
        const r = await ctx.switchPermissionTo(data.name);
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
          const job = await cron.addJob({
            cron: data.cron,
            when: data.when,
            prompt: data.prompt,
            preset: data.preset,
            tz: data.tz,
            sessionTitle: data.sessionTitle,
          });
          ws.send(JSON.stringify({ type: "cron_added", job }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "cron_error", action: "cron_add", message: err.message }));
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
        const sessions = await chatHistory.listSessions(ctx.sessionScopeFor(ws));
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
        if (
          data.resync === true &&
          ctx.isStreaming &&
          (ctx.turnOrigin?.sessionId ?? ctx.dshSessionId) !== data.id
        ) {
          const sess = await chatHistory.getSession(data.id).catch(() => null);
          ws.viewedSession = data.id;
          sendIfOpen(ws, {
            type: "session_loaded",
            id: data.id,
            title: sess?.title || "Chat",
            messages: sess?.messages || [],
            running: false,
          });
          sendIfOpen(ws, ctx.planMessage(data.id));
          {
            const question = ctx.questionMessage?.(data.id);
            if (question) sendIfOpen(ws, question);
          }
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
            const running =
              !!ctx.isStreaming && (ctx.turnOrigin?.sessionId ?? ctx.dshSessionId) === result.id;
            const turnEvents =
              running && ctx.turnBuffer && !ctx.turnBuffer.overflow && ctx.turnBuffer.events.length > 0
                ? ctx.turnBuffer.events.map((e) => ({ ...e }))
                : undefined;
            sendIfOpen(ws, {
              type: "session_loaded",
              id: result.id,
              title: result.title,
              messages: result.messages,
              running,
              ...(turnEvents ? { turnEvents } : {}),
            });
            sendIfOpen(ws, ctx.planMessage(result.id));
            {
              const question = ctx.questionMessage?.(result.id);
              if (question) sendIfOpen(ws, question);
            }
            break;
          }
          // Reconnect resync payload (add-reconnect-resync): report whether a
          // turn is in flight for THIS session, and when it is, the replayable
          // event log so the client rebuilds the open turn. Fields are
          // additive — older clients ignore them and keep today's behavior.
          const running =
            !!ctx.isStreaming && (ctx.turnOrigin?.sessionId ?? ctx.dshSessionId) === result.id;
          const turnEvents =
            running && ctx.turnBuffer && !ctx.turnBuffer.overflow && ctx.turnBuffer.events.length > 0
              ? ctx.turnBuffer.events.map((e) => ({ ...e }))
              : undefined;
          // Per-viewer delivery: the requester (now viewing the target) plus
          // any other connection already viewing it. Foreign clients keep
          // their own view and their own transcript.
          ctx.sendToViewers(result.id, {
            type: "session_loaded",
            id: result.id,
            title: result.title,
            messages: result.messages,
            running,
            ...(turnEvents ? { turnEvents } : {}),
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
          ctx.sendToViewers(result.id, { type: "session_changed", id: result.id });
          void ctx.broadcastSessions();
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
