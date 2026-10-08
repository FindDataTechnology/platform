// Agent-session state machine: session create/switch, model list/refresh/
// switch, catalog-agent switch, remote-agent streaming, and the /model + /new
// command handlers. Attached onto ctx by attachAgentSession; ws.js and the
// chat-history routes consume them through ctx.

import * as chatHistory from "../chat-history.js";
import { runA2aTurn, resolveGatewayCredential } from "./a2a-client.js";
import * as catalog from "../catalog.js";
import * as dshProfile from "../dsh-profile.js";
import path from "node:path";
import fs, { constants as fsConstants } from "node:fs/promises";

// Resolve and vet a client-supplied workspace path. Symlinks are resolved
// FIRST so the thing we validate is the thing we hand to dsh — validating the
// link and spawning in the target is how a check gets bypassed.
//
// Deliberately not an allowlist: the server already runs with the user's full
// filesystem access and the agent's tools are unconstrained, so gating the
// picker alone would be theatre. Real sandboxing belongs with tool permissions.
//
// Writable is a hard requirement, not a preference (fix-agent-workspace): the
// file-serving root and the resource-library save both key off the runtime
// cwd, so a read-only workspace silently breaks every produced-file consumer —
// the switch must refuse it up front instead.
export async function validateWorkspace(input) {
  if (typeof input !== "string" || !input.trim()) {
    return { ok: false, error: "Workspace path is required" };
  }
  const raw = input.trim();
  if (!path.isAbsolute(raw)) {
    return { ok: false, error: "Workspace path must be absolute" };
  }
  let resolved;
  try {
    resolved = await fs.realpath(raw);
  } catch (err) {
    return {
      ok: false,
      error: err.code === "ENOENT" ? `No such directory: ${raw}` : `Cannot read ${raw}: ${err.message}`,
    };
  }
  try {
    const st = await fs.stat(resolved);
    if (!st.isDirectory()) return { ok: false, error: `Not a directory: ${raw}` };
    await fs.access(resolved, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    return { ok: false, error: `Directory is not readable: ${raw}` };
  }
  try {
    await fs.access(resolved, fsConstants.W_OK);
  } catch {
    return { ok: false, error: `Directory is not writable: ${raw}` };
  }
  return { ok: true, path: resolved };
}

// Module scope on purpose: resolveBootWorkspace (server boot) and the
// switch-time persistence inside attachAgentSession share one key, and the
// recents key below lives in the closure.
export const WORKSPACE_CURRENT_KEY = "workspace.current";

// Boot-time workspace resolution (fix-agent-workspace). Precedence:
// AGENT_WORKSPACE pin > persisted current-workspace preference > process.cwd().
// The pin outranks the preference on purpose — a stale or dev-path preference
// is exactly how a deployment gets stranded in an unwritable root, and the env
// exists to override drift. Each tier runs the same validator, so "writable"
// is one rule, not two. The terminal cwd tier is always taken (there is no
// fallback behind it); its rejections are logged by the caller, never fatal.
// Rejections are returned, not logged here, so server.js emits them in its
// own boot-log dialect ([workspace] ... naming value and reason).
export async function resolveBootWorkspace({ env = process.env, getPreference = null } = {}) {
  const rejected = [];
  const pin = String(env.AGENT_WORKSPACE || "").trim();
  if (pin) {
    const v = await validateWorkspace(pin);
    if (v.ok) return { path: v.path, source: "env", rejected };
    rejected.push(`AGENT_WORKSPACE '${pin}' rejected: ${v.error}`);
  }
  if (getPreference) {
    const saved = String(getPreference(WORKSPACE_CURRENT_KEY) || "").trim();
    if (saved) {
      const v = await validateWorkspace(saved);
      if (v.ok) return { path: v.path, source: "preference", rejected };
      rejected.push(`saved workspace '${saved}' rejected: ${v.error}`);
    }
  }
  return { path: process.cwd(), source: "cwd", rejected };
}

export function attachAgentSession(ctx) {

function bumpSessionVersion() {
  ctx.sessionVersion = (ctx.sessionVersion || 0) + 1;
}

// Leaving the live chat mid-turn must not leave the old response streaming into
// the new transcript. dsh has no interrupt RPC, so a local turn is stopped the
// only reliable way available: close the child (the bridge immediately respawns
// with the same profile/MCP config). A remote-agent fork owns its fetch, so its
// AbortController is enough. In both cases finishTurn() first releases the UI;
// the subsequent bridge.exit then sees an idle runtime and adds no error banner.
async function stopStreamingForSessionNavigation() {
  if (!ctx.isStreaming) return;
  const remoteAbort = ctx.activeRemoteTurnAbort;
  ctx.finishTurn();
  if (remoteAbort) {
    remoteAbort.switchedAway = true;
    if (ctx.activeRemoteTurnAbort === remoteAbort) ctx.activeRemoteTurnAbort = null;
    remoteAbort.abort();
    return;
  }
  ctx.promptStoppedByNavigation = true;
  await ctx.dshBridge.restart({});
}

// Start a new chat session: create a fresh SDK session and reset the agent's
// in-memory messages. A live response is stopped first — navigation must never
// be hostage to a slow model.
async function createNewSession(ownerEmail = null) {
  await stopStreamingForSessionNavigation();
  ctx.session.sessionManager.newSession();
  const id = chatHistory.currentSessionId();
  chatHistory.createSession(id, ownerEmail);
  bumpSessionVersion();
  // ponytail: dsh has no in-memory message state to reset — newSession() (shim)
  // already minted a fresh dshSessionId; the next prompt carries it.
  return id;
}

// Switch the live agent to an existing session by id: point the session manager at
// that file and reload the agent's in-memory messages from it so the conversation
// continues with full context. A live response is stopped after the target is
// validated, so a bad target never costs the in-flight turn.
async function switchToSession(id) {
  const currentId = chatHistory.currentSessionId();
  if (id === currentId) {
    const sess = await chatHistory.getSession(id);
    return { id, title: sess?.title || "Chat", messages: sess?.messages || [] };
  }

  // Validate the target before changing the live session. dsh has no in-memory
  // message state to resync; switching the id is enough once SQLite confirms it.
  const version = ctx.sessionVersion;
  const sess = await chatHistory.getSession(id);
  if (ctx.sessionVersion !== version) throw new Error("Session changed while loading");
  if (!sess) throw new Error(`session ${id} not found`);
  await stopStreamingForSessionNavigation();
  ctx.session.sessionManager.setSessionId(id);
  bumpSessionVersion();
  return { id, title: sess.title || "Chat", messages: sess.messages || [] };
}

// ── Command + model/session helpers (used by the prompt dispatcher) ──────────

// The model list shown to clients. The profile generator's declared list IS the
// model list (no stock listModels RPC). Sourced once at initDshAgent from
// writeLlmProfile(). The env route and user providers can declare the same id
// (both point at overlapping gateway rosters); first occurrence wins so client
// pickers keyed by id never see duplicates.
async function getAvailableModels() {
  const seen = new Set();
  const models = [];
  for (const m of ctx.dshModels) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    models.push({
      id: m.id,
      name: m.name || m.id,
      provider: m.provider,
      ...(m.reasoningEfforts?.length ? { reasoningEfforts: m.reasoningEfforts } : {}),
    });
  }
  return models;
}

// The thinking levels the given model declares (empty = no control for it).
function effortsForModel(id) {
  return ctx.dshModels.find((m) => m.id === id)?.reasoningEfforts || [];
}

// Persist a provider's thinking level (null clears it) and reproject the dsh
// profile. The prefs row is the source of truth; settings.yaml is the projection
// writeLlmProfile() rebuilds on every boot (design D3).
function persistEffort(provider, effort) {
  ctx.db.setPreference(`llm.effort.${provider}`, effort || "");
}

// Switch the active thinking level. dsh has no effort RPC — the generated
// settings.yaml IS the transport, so applying it is the same restart path as a
// model switch (design D1). Returns { ok, error? } like switchModelTo.
async function switchEffortToInner(effort) {
  if (ctx.isStreaming) {
    return { ok: false, error: "Cannot change the thinking level while the agent is responding" };
  }
  const modelId = ctx.session?.model?.id;
  const provider = ctx.session?.model?.provider || ctx.defaultModel?.provider;
  if (!modelId || !provider) return { ok: false, error: "No active model" };
  const allowed = effortsForModel(modelId);
  // null/"" = back to the provider default, always allowed.
  if (effort && !allowed.includes(effort)) {
    return { ok: false, error: `Model ${modelId} does not support thinking level "${effort}"` };
  }
  if ((ctx.currentEffort || null) === (effort || null)) return { ok: true };
  const level = effort || null;
  try {
    persistEffort(provider, level);
    if (!dshProfileMod) dshProfileMod = await import("../dsh-profile.js");
    await dshProfileMod.writeLlmProfile();
    await ctx.dshBridge.restart({ provider, model: modelId });
    ctx.currentEffort = level;
    ctx.broadcast({ type: "effort_changed", effort: level });
    return { ok: true };
  } catch (err) {
    console.error("[dsh] thinking-level switch failed:", err.message);
    return { ok: false, error: err.message };
  }
}

async function switchEffortTo(effort) {
  if (ctx.runExclusiveRuntimeMutation) {
    return ctx.runExclusiveRuntimeMutation(() => switchEffortToInner(effort));
  }
  return switchEffortToInner(effort);
}

// Refresh the model list at runtime (design D3 / spike 2). Re-runs writeLlmProfile
// so settings.yaml is rewritten; dsh-settings-file hot-reloads the
// llm-pi-ai: section and dsh-llm-pi-ai's onChange re-registers the adapter
// routes + model directory live (no restart). dshModels is updated from the
// fresh declared list and clients are told to refetch.
// ponytail: the active model is left as-is; a switch to a newly-appeared model
// still goes through switchModelTo (which restarts — the per-session model is an
// initialize arg, a genuine ceiling). This only refreshes the *selector*.
let dshProfileMod = null;
async function refreshDshModels() {
  if (!dshProfileMod) dshProfileMod = await import("../dsh-profile.js");
  const { models } = await dshProfileMod.writeLlmProfile();
  const before = ctx.dshModels.map((m) => m.id).join(",");
  ctx.dshModels = models;
  const after = ctx.dshModels.map((m) => m.id).join(",");
  if (before !== after) console.log(`[dsh] model list refreshed: ${after || "(none)"}`);
  ctx.broadcast({ type: "models", models: await getAvailableModels() });
  return ctx.dshModels.map((m) => ({ id: m.id, name: m.name || m.id, provider: m.provider }));
}

// Switch the active model by id, enforcing the streaming guard. Returns
// { ok, error? } — callers decide how to surface a failure: `/model` emits the
// command_use block FIRST so the error attaches to that turn, while `set_model`
// sends it bare (the client shows it as a toast: no run is open). Shared by
// the `set_model` WS handler and the `/model` command.
async function switchModelToInner(id) {
  if (ctx.isStreaming) {
    return { ok: false, error: "Cannot switch model while the agent is responding" };
  }
  // ponytail: no stock setModel RPC, so a live switch restarts the bridge with
  // the new provider/model baked into initialize. This drops the child's
  // in-memory session state (v1 ceiling); a non-disruptive switch needs a
  // custom dsh RPC. Unknown model → "Unknown model" error.
  const target = ctx.dshModels.find((m) => m.id === id);
  if (!target) {
    return { ok: false, error: `Unknown model: ${id}` };
  }
  if (ctx.session?.model?.id === id) return { ok: true };
  // The persisted effort belongs to a provider, but the offered set is the new
  // model's. An incompatible level falls back to the provider default rather
  // than reaching dispatch as UNSUPPORTED_REASONING_EFFORT.
  const carried = ctx.db.getPreference(`llm.effort.${target.provider}`) || null;
  const effort = carried && (target.reasoningEfforts || []).includes(carried) ? carried : null;
  if (carried && !effort) persistEffort(target.provider, null);
  try {
    if (effort !== ctx.currentEffort) {
      if (!dshProfileMod) dshProfileMod = await import("../dsh-profile.js");
      await dshProfileMod.writeLlmProfile();
    }
    await ctx.dshBridge.restart({ provider: target.provider, model: target.id });
    ctx.session.model = { id: target.id };
    ctx.defaultModel = { id: target.id, provider: target.provider, name: target.name || target.id };
    // Keep the effective runtime model in step: ws.js reports current_model and
    // runtime-bindings broadcasts runtime_binding from it, so an explicit switch
    // that left it stale would make both name the previous model.
    ctx.runtimeModel = { id: target.id, provider: target.provider, name: target.name || target.id };
    ctx.currentEffort = effort;
    ctx.broadcast({ type: "model_changed", id, effort });
    return { ok: true };
  } catch (err) {
    console.error("[dsh] model switch failed:", err.message);
    return { ok: false, error: err.message };
  }
}

async function switchModelTo(id) {
  if (ctx.runExclusiveRuntimeMutation) {
    return ctx.runExclusiveRuntimeMutation(() => switchModelToInner(id));
  }
  return switchModelToInner(id);
}

// ── Catalog agent switching (mirrors the model-selection messages) ───────────

// How many mirrored turns a remote fork replays. Enough to hold a working
// conversation without spending the entry's context window on history.
const REMOTE_FORK_HISTORY_MAX = Number(process.env.REMOTE_FORK_HISTORY_MAX || 24);

// Agents the agent switcher offers: the local dsh session plus visible
// chat-mode remote agents (link agents are external pages, not chat targets).
function switchableAgents(user) {
  return catalog
    .getCatalogFor(user ?? null)
    .agents.filter(
      (a) =>
        a.type === "agent-local" ||
        // chat-mode remote agents (preset or fork) and deployed Agent Services
        // (a2a — served over the registry gateway, task 5.3).
        (a.type === "agent-remote" && (a.mode === "chat" || a.mode === "a2a")),
    );
}

// The remote chat fork applies to a chat-mode entry ONLY while the deployment
// has no local persona preset for it. Every entry with a generated preset (see
// dsh-profile.writeCatalogAgentPresets) runs on the LOCAL agent instead: the
// preset carries its persona, and the turn keeps the local runtime's tools
// (MCP servers, skills) and its session history. An entry may opt out of that
// with `local: false` — the operator declaring it a real remote service.
// Returns the entry to fork to, or null to stay local.
function remoteChatEntryFor(id) {
  if (!id || id === "local") return null;
  const entry = catalog.getAgentEntry(id);
  if (!entry || entry.type !== "agent-remote") return null;
  // A deployed Agent Service is always remote — it runs on the agent-runner,
  // never as a local persona preset (add-a2a-agent-serving 5.3).
  if (entry.mode === "a2a") return entry;
  if (entry.mode !== "chat") return null;
  if (entry.local === false) return entry;
  return dshProfile.hasCatalogAgentPreset(id) ? null : entry;
}

// Which catalog agent is an agent preset's persona? Inverse of the switch below,
// used at boot to report the agent that the persisted preset choice belongs to.
// The preset id may be the roster/dash form of a dotted catalog id (custom
// presets) — match through the same mapping the switch applies.
function catalogAgentForPreset(presetId) {
  if (!presetId) return "local";
  const entry = catalog.getChatAgentEntries().find(
    (e) => e.id === presetId || dshProfile.rosterPresetId(e.id) === presetId,
  );
  return entry && dshProfile.hasCatalogAgentPreset(entry.id) ? entry.id : "local";
}

// Switch the active catalog agent by id. Same contract as switchModelTo:
// rejected while streaming, errors go to the requesting client only.
//
// An agent with a local persona preset is a PRESET switch, not a routing
// change: dsh composes a session's persona from its preset at creation, so
// applying one restarts the child (the shared path for model/workspace/preset
// switches) and takes effect on the next session. `local` restores the
// deployment's persisted preset, dropping a pack persona.
// The preset a switch back to `local` restores. A selected pack agent also
// lands in `agent.preset` (that is what a restart composes), so the pick made
// before the pack is parked here — otherwise returning to `local` would
// re-select the pack and the picker would name an agent the persona is not.
const OWN_PRESET_KEY = "agent.preset.own";

function ownPreset() {
  const persisted = ctx.db.getPreference("agent.preset");
  if (persisted && !dshProfile.hasCatalogAgentPreset(persisted)) return persisted;
  return ctx.db.getPreference(OWN_PRESET_KEY) || dshProfile.DEFAULT_AGENT_PRESET;
}

async function switchAgentToInner(id, ws) {
  if (ctx.isStreaming) {
    ws.send(JSON.stringify({ type: "error", message: "Cannot switch agent while the agent is responding" }));
    return false;
  }
  const target = switchableAgents(ws.user).find((a) => a.id === id);
  if (!target) {
    ws.send(JSON.stringify({ type: "error", message: `Unknown agent: ${id}` }));
    return false;
  }
    const isPack = id !== "local" && dshProfile.hasCatalogAgentPreset(id);
    const isLocalAgent = id === "local" || isPack;
    if (isLocalAgent) {
      if (isPack) {
        const persisted = ctx.db.getPreference("agent.preset");
        if (persisted && persisted !== id && !dshProfile.hasCatalogAgentPreset(persisted)) {
          ctx.db.setPreference(OWN_PRESET_KEY, persisted);
        }
      }
      // A locally-served catalog agent applies through the ROSTER form of its
      // id (dotted catalog ids — custom presets — become dash dirs; the
      // switch and the persisted preference speak the roster's language).
      const localPreset = isPack ? dshProfile.rosterPresetId(id) : ownPreset();
    if (localPreset !== ctx.currentPreset) {
      const r = await switchPresetToInner(localPreset);
      if (!r.ok) {
        if (r.error) ws.send(JSON.stringify({ type: "error", message: r.error }));
        return false;
      }
    }
  }
  if (id === ctx.currentAgentId) return true;
  ctx.currentAgentId = id;
  ctx.broadcast({ type: "agent_changed", id });
  return true;
}

function switchAgentTo(id, ws) {
  if (ctx.runExclusiveRuntimeMutation) {
    return ctx.runExclusiveRuntimeMutation(() => switchAgentToInner(id, ws));
  }
  return switchAgentToInner(id, ws);
}

// Regenerate the per-entry persona presets from the merged catalog and, when
// they changed, restart the idle child so its `presets/list` roster includes
// them. Called on every catalog change (the minute poll plus the initial cloud
// merge); a no-op when nothing changed, so the poll costs nothing.
async function syncCatalogAgentPresets() {
  let result;
  try {
    result = dshProfile.writeCatalogAgentPresets(catalog.getChatAgentEntries());
  } catch (err) {
    console.warn(`[dsh] catalog agent preset sync failed: ${err.message}`);
    return { changed: false };
  }
  // A pack that left the catalog leaves a stale selection behind; report the
  // fallback before the restart so clients never show a departed agent.
  if (ctx.currentAgentId !== "local" && !dshProfile.hasCatalogAgentPreset(ctx.currentAgentId)) {
    ctx.currentAgentId = catalogAgentForPreset(ctx.currentPreset);
    ctx.broadcast({ type: "agent_changed", id: ctx.currentAgentId });
  }
  if (result.changed && ctx.dshBridge?.isReady?.() && !ctx.isStreaming) {
    const restart = () => ctx.dshBridge.restart({});
    try {
      // Serialized with model/workspace/preset switches: a restart here must not
      // overlap one of those (both re-spawn the same child). Already INSIDE an
      // exclusive mutation (e.g. a custom-preset CRUD route awaiting this sync
      // from within its own serialized section)? Run directly — re-queuing on
      // the chain would wait on ourselves forever (the dshUpdateSkills guard).
      if (ctx.runtimeApplying?.()) await restart();
      else if (ctx.runExclusiveRuntimeMutation) await ctx.runExclusiveRuntimeMutation(restart);
      else await restart();
      await getAgentPresets();
      console.log(`[dsh] runtime restarted for ${result.ids.length} catalog agent preset(s)`);
    } catch (err) {
      console.warn(`[dsh] catalog agent preset restart failed: ${err.message}`);
    }
  }
  return result;
}

// The conversation so far, shaped for an OpenAI-compatible request. The remote
// fork keeps no server-side session state, so without this every turn arrives as
// a first message: the agent cannot follow up on anything it just said. Reads the
// host's SQLite mirror (the store of record for chat history), which already
// contains the prompt being answered by the time the stream starts.
function remoteForkMessages() {
  try {
    const rows = ctx.db?.getChatMessages?.(chatHistory.currentSessionId()) || [];
    const turns = rows
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .slice(-REMOTE_FORK_HISTORY_MAX)
      .map((m) => ({ role: m.role, content: m.content }));
    if (turns.length) return turns;
  } catch (err) {
    console.warn(`[remote-agent] history unavailable: ${err.message}`);
  }
  return null;
}

// Fork a prompt to a remote OpenAI-compat endpoint: POST <baseUrl>/chat/completions
// with stream:true and translate SSE deltas into the existing text events, so the
// frontend renders remote agents exactly like the local one. v1 ceiling: remote
// turns are broadcast-only (no chat-history persistence) and one at a time — a
// prompt while a remote turn is streaming is rejected instead of steered.
// Only reached for chat-mode entries the deployment has no local persona preset
// for (ctx.remoteChatEntryFor); an entry that has one runs on the local agent.
async function streamRemoteChat(entry, text) {
  ctx.isStreaming = true; // set synchronously (same contract as the local prompt path)
  // The session is captured BEFORE the fetch: navigation may switch the live
  // chat while this request is still open, and the partial reply belongs to the
  // session that asked, never to whichever session is on screen when it lands.
  const sessionId = chatHistory.currentSessionId();
  const abort = new AbortController();
  ctx.activeRemoteTurnAbort = abort;
  const timeout = setTimeout(() => abort.abort(), 300_000);
  ctx.sendToViewers(sessionId, { type: "agent_start" });
  // Persist the user turn to the SQLite mirror (design D6) — closes the v1
  // ceiling where remote turns were broadcast-only and a browser close/reopen
  // left a dangling user message with no reply. Owner from the turn origin
  // (beginTurnFor ran before dispatch; add-session-ownership).
  chatHistory.recordMessage(sessionId, "user", text, undefined, ctx.turnOrigin?.user ?? null);
  // A fork has no system prompt of its own; give it the catalog entry's identity
  // so it answers as the named agent rather than as a bare model.
  const messages = [
    ...(entry.description
      ? [{ role: "system", content: `你是「${entry.name || entry.id}」——${entry.description}。回答用中文（除非用户使用其他语言），结论先行；没有工具可用时如实说明，不要编造数据或结论。平台产物契约：图表一律用 \`\`\`echarts 围栏输出 JSON option（不用 mermaid），平台会渲染并自动存入资源库；如引用产出文件，用工作区相对路径 markdown 链接；禁用 data: URI 链接；不要声称平台无法渲染或交付你的产物。` }]
      : []),
    ...(remoteForkMessages() || [{ role: "user", content: text }]),
  ];
  let assistantText = "";
  try {
    const headers = { "Content-Type": "application/json" };
    if (entry.apiKey) headers.Authorization = `Bearer ${entry.apiKey}`;
    const r = await fetch(`${entry.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: entry.model, messages, stream: true }),
      signal: abort.signal,
    });
    if (!r.ok) throw new Error(`${entry.id} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body) {
      // Navigation already closed this turn; a chunk that raced the abort must
      // not leak into whichever transcript is on screen now.
      if (abort.switchedAway) break;
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") continue;
        let delta;
        try {
          delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        } catch {
          continue; // ponytail: skip malformed SSE lines rather than kill the stream
        }
        if (delta) {
          assistantText += delta;
          ctx.sendToViewers(sessionId, { type: "text", delta });
        }
      }
    }
  } catch (err) {
    // Switching away aborts the fetch on purpose. The turn was already closed
    // with `done`; a follow-up abort error would land in the NEW transcript.
    if (!abort.switchedAway) {
      console.error(`Remote agent '${entry.id}' error:`, err.message);
      ctx.sendToViewers(sessionId, { type: "error", message: err.message });
    }
  } finally {
    clearTimeout(timeout);
    // Capture ownership BEFORE clearing the slot: a normal completion must
    // still emit done, while a navigation-aborted run must not finish whatever
    // new turn has taken the slot in the meantime.
    const ownsTurn = ctx.activeRemoteTurnAbort === abort;
    // Persist the assistant's final aggregated text (design D6), always to the
    // session that owns this turn.
    if (assistantText) chatHistory.recordMessage(sessionId, "assistant", assistantText, undefined, ctx.turnOrigin?.user ?? null);
    if (ctx.isStreaming && ownsTurn) ctx.finishTurn();
    if (ownsTurn) ctx.activeRemoteTurnAbort = null;
  }
}

// Handle `/model [id]`: with no id, report the current model + available models;
// with an id, switch (via switchModelTo) and emit a command_use block describing the result.
// Fork a prompt to a deployed Agent Service (a2a mode, add-a2a-agent-serving
// 5.3): the platform is the A2A CLIENT. The turn goes to the entry's registry
// gateway route via message/stream, with the caller's gateway credential on
// X-Authorization (stripped by the gateway after /validate) and the
// deployment's agent credential on Authorization (end-to-end, per upstream's
// egress trust model). Conversation continuity rides context_id = OUR session
// id — the runner keeps its own per-context session, so no history replay is
// needed (unlike the OpenAI-compatible fork above). SSE events from the runner
// map onto the existing text/done/error contract.
async function streamA2aChat(entry, text) {
  ctx.isStreaming = true;
  const sessionId = chatHistory.currentSessionId();
  const abort = new AbortController();
  ctx.activeRemoteTurnAbort = abort;
  const timeout = setTimeout(() => abort.abort(), 300_000);
  ctx.sendToViewers(sessionId, { type: "agent_start" });
  chatHistory.recordMessage(sessionId, "user", text, undefined, ctx.turnOrigin?.user ?? null);

  const ownerEmail = ctx.cellUserEmail || ctx.turnOrigin?.user?.email || null;
  const { gatewayToken } = resolveGatewayCredential({ ownerEmail, cloudMode: !!ctx.CLOUD_MODE });
  const agentToken = process.env.AGENT_SERVING_BACKEND_TOKEN || "";
  let assistantText = "";
  try {
    let sent = 0;
    const out = await runA2aTurn(entry.url, text, {
      contextId: sessionId,
      gatewayToken,
      agentToken,
      signal: abort.signal,
      onDelta: (delta) => {
        sent += delta.length;
        assistantText += delta;
        ctx.sendToViewers(sessionId, { type: "text", delta });
      },
    });
    if (out.text && out.text.length > sent) {
      ctx.sendToViewers(sessionId, { type: "text", delta: out.text.slice(sent) });
    }
    assistantText = out.text || assistantText;
  } catch (err) {
    if (!abort.switchedAway) {
      console.error(`A2A agent '${entry.id}' error:`, err.message);
      ctx.sendToViewers(sessionId, { type: "error", message: err.message });
    }
  } finally {
    clearTimeout(timeout);
    const ownsTurn = ctx.activeRemoteTurnAbort === abort;
    if (assistantText) chatHistory.recordMessage(sessionId, "assistant", assistantText, undefined, ctx.turnOrigin?.user ?? null);
    if (ctx.isStreaming && ownsTurn) ctx.finishTurn();
    if (ownsTurn) ctx.activeRemoteTurnAbort = null;
  }
}

async function handleModelCommand(args, ws) {
  const id = (args || "").trim();
  const current = ctx.session?.model?.id || "(none)";
  if (!id) {
    const models = await getAvailableModels();
    const modelList = models.map((m) => `  ${m.id}${m.id === current ? " (active)" : ""}`).join("\n");
    ctx.broadcast({
      type: "command_use",
      name: "model",
      args: "",
      message: `Current model: ${current}\n\nAvailable models (${models.length}):\n${modelList}`,
    });
    return;
  }
  const result = await switchModelTo(id);
  ctx.broadcast({
    type: "command_use",
    name: "model",
    args: id,
    message: result.ok ? `Model switched to ${id}` : `Could not switch model to ${id}`,
  });
  // After the command_use block opens the turn, send the failure detail so it
  // renders as an in-turn error block (an error sent BEFORE the block would be
  // an orphan — the client would toast it and the transcript would lose it).
  if (!result.ok && result.error) {
    ws.send(JSON.stringify({ type: "error", message: result.error }));
  }
}

// Create a new session and broadcast the session_changed/session_loaded/sessions
// sequence. Shared by the `new_session` WS handler, the `/new` command, and the
// REST new-session route. Errors propagate to the caller.
async function startNewSession(originWs = null, ownerEmail = null) {
  const id = await createNewSession(ownerEmail);
  // Per-viewer delivery (add-session-ownership): the REQUESTING connection
  // adopts the new session as its view and gets the load/changed/plan pushes;
  // every other client keeps its own view and transcript. A fresh session
  // carries no plan: the requester gets the empty list explicitly (the client
  // also clears on session_loaded). Any previous session's cached plan is
  // deliberately KEPT — it is that session's state, restored on switch-back.
  if (originWs) originWs.viewedSession = id;
  const toOrigin = (msg) => {
    if (originWs?.readyState !== originWs?.OPEN) return;
    try {
      originWs.send(JSON.stringify({ ...msg, sessionId: id }));
    } catch {
      /* a dying requester must not fail the new-session flow */
    }
  };
  toOrigin({ type: "session_changed", id });
  toOrigin({ type: "session_loaded", id, title: "New chat", messages: [] });
  toOrigin(ctx.planMessage(id));
  void ctx.broadcastSessions();
  return id;
}

// Handle `/new`: start a new session, then emit a command_use block (after the
// session_loaded clear so the block renders in the fresh chat).
async function handleNewCommand(ws) {
  try {
    await startNewSession(ws);
    // The /new block belongs to the transcript of the client that asked for
    // it — a foreign client's transcript must not grow a block it never
    // requested (add-session-ownership).
    if (ws?.readyState === ws?.OPEN) {
      ws.send(JSON.stringify({ type: "command_use", name: "new", args: "", message: "Started a new chat" }));
    }
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: err.message }));
  }
}


// ── Agent preset (agent mode) ────────────────────────────────────────────────

// The preset roster the running dsh child composes, via the bridge's
// `presets/list` (cached per child generation inside the bridge). Null roster
// → empty list: the picker renders nothing and switching rejects. Also kept
// on ctx.presetRoster so connect-time syncs never re-query.
async function getAgentPresets() {
  if (!ctx.dshBridge?.isReady?.()) return [];
  try {
    const presets = await ctx.dshBridge.listPresets();
    ctx.presetRoster = Array.isArray(presets) ? presets : [];
    return ctx.presetRoster;
  } catch (err) {
    console.warn("[dsh] presets/list failed:", err.message);
    return ctx.presetRoster || [];
  }
}

// Switch the selected agent preset. dsh composes a session's capabilities from
// its preset at creation and refuses to recompose a session that has produced
// turns, so — exactly like a model or workspace switch, which share the same
// constraint — applying a choice means restarting the child with the preset
// baked into `initialize`; it then applies to the next (blank) session. The
// streaming guard matches set_model. Returns { ok, error? }.
async function switchPresetToInner(id) {
  if (ctx.isStreaming) {
    return { ok: false, error: "Cannot change the agent mode while the agent is responding" };
  }
  if (id === ctx.currentPreset) return { ok: true };
  const roster = await getAgentPresets();
  if (!roster.length) {
    return { ok: false, error: "No agent modes are available in this deployment" };
  }
  const target = roster.find((p) => p.id === id);
  if (!target) {
    return { ok: false, error: `Unknown agent mode: ${id}` };
  }
  if (target.broken) {
    return { ok: false, error: `Agent mode "${id}" is unavailable: ${target.broken}` };
  }
  try {
    // Focus rewrite (add-pack-agent-scoping): the scope is derived from the
    // TARGET preset, so both patches are rewritten through the scoped writers
    // before the one restart that carries the persona — restart() takes no
    // skillsPatchPath (constructor-only), and the child re-reads the file at
    // spawn, so the same-path rewrite IS the delivery (design D2). The overlay/
    // groups/owner reproduce the runtime's effective profile so nothing the
    // current identity narrowed re-opens.
    await dshProfile.writeMcpPatch({
      mcpOverlay: ctx.runtimeMcpOverlay ?? null,
      userGroups: ctx.runtimeOwnerGroups ?? null,
      ownerEmail: ctx.runtimeOwnerEmail,
      agentPreset: id,
    });
    await dshProfile.writeSkillsPatch({ agentPreset: id });
    await ctx.dshBridge.restart({ agentPreset: id });
    // Restart succeeded — the choice is now the deployment default. Persisted
    // AFTER the restart so a failed restart leaves the previous preference
    // (still reported as current) untouched.
    ctx.db.setPreference("agent.preset", id);
    ctx.currentPreset = id;
    ctx.broadcast({ type: "current_preset", id });
    return { ok: true };
  } catch (err) {
    console.error("[dsh] preset switch failed:", err.message);
    // The patches may already carry the TARGET's scope while the child still
    // runs the old preset — restore them to the live preset so a failed
    // switch is not half-applied (the next boot re-derives regardless).
    try {
      await dshProfile.writeMcpPatch({
        mcpOverlay: ctx.runtimeMcpOverlay ?? null,
        userGroups: ctx.runtimeOwnerGroups ?? null,
        ownerEmail: ctx.runtimeOwnerEmail,
        agentPreset: ctx.currentPreset,
      });
      await dshProfile.writeSkillsPatch({ agentPreset: ctx.currentPreset });
    } catch (restoreErr) {
      console.warn(`[dsh] preset switch patch restore failed: ${restoreErr.message}`);
    }
    return { ok: false, error: err.message };
  }
}

async function switchPresetTo(id) {
  if (ctx.runExclusiveRuntimeMutation) {
    return ctx.runExclusiveRuntimeMutation(() => switchPresetToInner(id));
  }
  return switchPresetToInner(id);
}

// ── Permission preset (sandbox + approval mode) ──────────────────────────────

// The composed permission preset table via the bridge's `permissions/list` —
// roster options with client labels plus the session's effective preset (the
// deployment default until a session pins one). NOT cached: the payload's
// `current` is live state, and calls are rare, user-triggered refreshes.
// Returns { options, current }; empty options = no permission service
// composed → the strip control stays hidden.
async function getPermissionPresets() {
  if (!ctx.dshBridge?.isReady?.()) return { options: [], current: ctx.currentPermission };
  try {
    const r = await ctx.dshBridge.listPermissionPresets(ctx.dshSessionId);
    ctx.permissionOptions = Array.isArray(r?.options) ? r.options : [];
    if (r?.current) ctx.currentPermission = r.current;
    return { options: ctx.permissionOptions, current: ctx.currentPermission };
  } catch (err) {
    console.warn("[dsh] permissions/list failed:", err.message);
    return { options: ctx.permissionOptions, current: ctx.currentPermission };
  }
}

// Switch the LIVE session's permission preset. Deliberately unlike
// set_model/set_workspace/set_preset: no child restart — the runtime appends
// a durable permission/preset session event and rewrites its sandbox/approval
// knobs in place. The streaming guard matches set_model (a loosening must
// never interleave with a turn it was not visible to). Returns { ok, error? }.
async function switchPermissionTo(name) {
  if (ctx.isStreaming) {
    return { ok: false, error: "Cannot change the permission mode while the agent is responding" };
  }
  if (name === ctx.currentPermission) return { ok: true };
  const { options } = await getPermissionPresets();
  if (!options.length) {
    return { ok: false, error: "No permission modes are available in this deployment" };
  }
  if (!options.some((o) => o.name === name)) {
    return { ok: false, error: `Unknown permission mode: ${name}` };
  }
  try {
    const r = await ctx.dshBridge.setPermissionPreset(ctx.dshSessionId, name);
    ctx.currentPermission = r?.current ?? name;
    ctx.broadcast({ type: "current_permission", name: ctx.currentPermission });
    return { ok: true };
  } catch (err) {
    console.error("[dsh] permission switch failed:", err.message);
    return { ok: false, error: err.message };
  }
}

// ── Workspace (dsh cwd) ─────────────────────────────────────────────────────

const WORKSPACE_RECENTS_KEY = "workspace.recents";
const WORKSPACE_RECENTS_MAX = 8;

function readRecents() {
  try {
    const raw = ctx.db.getPreference(WORKSPACE_RECENTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((p) => typeof p === "string") : [];
  } catch {
    // A corrupt prefs row must not brick the composer — start the list over.
    return [];
  }
}

function pushRecent(dir) {
  const next = [dir, ...readRecents().filter((p) => p !== dir)].slice(0, WORKSPACE_RECENTS_MAX);
  ctx.db.setPreference(WORKSPACE_RECENTS_KEY, JSON.stringify(next));
  return next;
}

// Persist the current workspace (fix-agent-workspace): recents alone never
// restored anything — the switch was silently undone by the next restart.
// Best-effort: an unwritable store logs nothing and the runtime keeps the
// switched cwd either way.
function persistCurrentWorkspace(dir) {
  try {
    ctx.db.setPreference(WORKSPACE_CURRENT_KEY, dir);
  } catch {
    /* preference store unavailable — the switch itself already succeeded */
  }
}

function currentWorkspace() {
  return ctx.dshBridge?.getCwd?.() || process.cwd();
}

// Switch the dsh runtime's working directory. `cwd` is fixed in the initialize
// handshake with no RPC to change it, so this is the same restart path as a
// model or thinking-level switch. Returns { ok, error? }.
async function switchWorkspaceToInner(input) {
  if (ctx.isStreaming) {
    return { ok: false, error: "Cannot change the workspace while the agent is responding" };
  }
  const v = await validateWorkspace(input);
  // A bad path must not cost a restart, and must not half-switch the runtime.
  if (!v.ok) return v;
  const previous = currentWorkspace();
  if (v.path === previous) {
    // No restart to do, but heal a missing/stale current row (idempotent).
    persistCurrentWorkspace(v.path);
    return { ok: true };
  }
  try {
    await ctx.dshBridge.restart({ cwd: v.path });
  } catch (err) {
    console.error("[dsh] workspace switch failed:", err.message);
    // Best-effort return to the directory that was known to work; if that also
    // fails the bridge's own backoff ladder owns recovery from here.
    try {
      await ctx.dshBridge.restart({ cwd: previous });
      persistCurrentWorkspace(previous);
    } catch (restoreErr) {
      console.error("[dsh] workspace restore failed:", restoreErr.message);
    }
    return { ok: false, error: `Could not start the agent in ${v.path}: ${err.message}` };
  }
  pushRecent(v.path);
  persistCurrentWorkspace(v.path);
  ctx.broadcast({ type: "workspace_changed", path: v.path });
  return { ok: true };
}

async function switchWorkspaceTo(input) {
  if (ctx.runExclusiveRuntimeMutation) {
    return ctx.runExclusiveRuntimeMutation(() => switchWorkspaceToInner(input));
  }
  return switchWorkspaceToInner(input);
}

function listWorkspaces() {
  const current = currentWorkspace();
  return { current, recents: [current, ...readRecents().filter((p) => p !== current)] };
}

  ctx.createNewSession = createNewSession;
  ctx.switchToSession = switchToSession;
  ctx.getAvailableModels = getAvailableModels;
  ctx.refreshDshModels = refreshDshModels;
  ctx.switchModelTo = switchModelTo;
  ctx.switchEffortTo = switchEffortTo;
  ctx.effortsForModel = effortsForModel;
  ctx.switchableAgents = switchableAgents;
  ctx.switchAgentTo = switchAgentTo;
  ctx.remoteChatEntryFor = remoteChatEntryFor;
  ctx.catalogAgentForPreset = catalogAgentForPreset;
  ctx.syncCatalogAgentPresets = syncCatalogAgentPresets;
  ctx.streamRemoteChat = streamRemoteChat;
  ctx.streamA2aChat = streamA2aChat;
  ctx.handleModelCommand = handleModelCommand;
  ctx.startNewSession = startNewSession;
  ctx.handleNewCommand = handleNewCommand;
  ctx.switchWorkspaceTo = switchWorkspaceTo;
  ctx.listWorkspaces = listWorkspaces;
  ctx.getAgentPresets = getAgentPresets;
  ctx.switchPresetTo = switchPresetTo;
  ctx.getPermissionPresets = getPermissionPresets;
  ctx.switchPermissionTo = switchPermissionTo;
}
