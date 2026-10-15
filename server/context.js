// Shared application context — the single home for cross-cutting mutable
// state that used to live in module scope in server.js. Every server/*
// module receives `ctx` as its first parameter and closes over nothing
// global; only server.js (the composition root) constructs the context.
//
// State groups:
//   - config:        parsed once by server.js, passed into createAppContext
//   - services:      the root service singletons (db, chat-history, …)
//   - agent session: session/isStreaming/dshBridge/… — written by
//                    initDshAgent + agent-session.js, read by ws.js,
//                    dsh-events.js and the route modules
//   - clients:       connected WS sockets; broadcast() fans out to them

import { repoRoot } from "../paths.js";
import * as chatHistory from "../chat-history.js";
import * as documents from "../documents.js";
import * as collections from "../collections.js";
import * as db from "../db.js";
import * as migrate from "../migrate.js";
import * as cron from "../cron.js";
import * as extensionStore from "../extension-store.js";
import * as skillMaterialize from "../skill-materialize.js";
import * as catalog from "../catalog.js";

// Split a bundle-manifest permissions policy ("mcp:<name>"/"skill:<name>" →
// { allow?, deny?, locked? }) into the extensions-DB columns: the locked flag
// plus the stored permissions JSON ({ allow?, deny? } — locked has its own column).
export function splitPolicy(policy) {
  if (!policy) return { locked: false, permissions: null };
  const { allow, deny } = policy;
  const permissions =
    allow || deny ? { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) } : null;
  return { locked: policy.locked === true, permissions };
}

// The web SPA build served at the repo root (express.static + SPA fallback).
// repoRoot, not cwd: hosted cells sit in a per-user cwd (tenant-cell-runtime).
export const WEB_DIST = repoRoot("web/dist");


// The per-session turn-state module (live-runtime-control D4): streaming
// flags, turn origin, replay buffers, and the derived any-streaming getter.
// Exported so hand-built test contexts can attach the same machinery the real
// app context gets — one source of truth for what a streaming-scoped path may
// touch.
export function attachTurnStateModule(c) {
  if (typeof c.turnStateFor === "function") return c; // already attached (idempotence)
  const TURN_BUFFER_MAX_EVENTS = 2000;
  const TURN_BUFFER_MAX_BYTES = 1_000_000;
  c.turnStateBySession = c.turnStateBySession || new Map();
  c.webTurnSessions = c.webTurnSessions || new Set();
  // The single accessor every streaming-scoped path goes through. State is
  // created on demand and evicted when its turn closes (finishTurn) — an idle
  // session holds no entry. `isStreaming` stays a derived getter over the map
  // so the "is the runtime busy anywhere" reads (idle-apply, cron single
  // flight, restart-carrying switch guards) keep one source of truth.
  c.turnStateFor = (sid) => {
    let T = c.turnStateBySession.get(sid);
    if (!T) {
      T = {
        isStreaming: false,
        origin: null,
        startedAt: null,
        error: null,
        toolNames: new Map(),
        blocks: [],
        usage: null,
        promptStopped: false,
        currentTurnId: null,
        // Live delta lane bookkeeping (restore-assistant-stream-020): true
        // once any text/thinking delta reached this session's viewers this
        // turn — gates the settled-text fallback so a segment is emitted
        // exactly once (chat-streaming's exactly-once requirement).
        streamedText: false,
      };
      c.turnStateBySession.set(sid, T);
    }
    return T;
  };
  c.isStreamingFor = (sid) => c.turnStateBySession.get(sid)?.isStreaming === true;
  c.setStreaming = (sid, value) => {
    c.turnStateFor(sid).isStreaming = value;
  };
  Object.defineProperty(c, "isStreaming", {
    get() {
      for (const T of c.turnStateBySession.values()) if (T.isStreaming) return true;
      return false;
    },
    // Defensive: a stray write must never shadow the getter silently.
    set() {
      throw new Error("isStreaming is derived — use setStreaming(sessionId, boolean)");
    },
  });
  // Every session with an open turn (bridge-exit fan-out, navigation stops).
  c.streamingSessions = () =>
    [...c.turnStateBySession.entries()].filter(([, T]) => T.isStreaming).map(([sid]) => sid);
  // ── In-flight turn replay buffers (add-reconnect-resync; per-session D4) ───
  // One bounded buffer PER session — concurrent turns must never interleave
  // into one replay log. Same bounds and same ephemerality as before: cleared
  // when that session's turn ends, dropped whole on overflow, never persisted.
  c.turnBuffers = new Map(); // sid -> { events, bytes, overflow }
  c.turnBufferFor = (sid) => c.turnBuffers.get(sid) ?? null;
  // A fresh turn's log must not inherit the previous turn's events (a done
  // that raced a crash could leave one behind).
  c.resetTurnBuffer = (sid) => {
    if (sid) c.turnBuffers.delete(sid);
  };
  const appendTurnBuffer = (sid, data) => {
    let buf = c.turnBuffers.get(sid);
    if (!buf) {
      buf = { events: [], bytes: 0, overflow: false };
      c.turnBuffers.set(sid, buf);
    }
    if (buf.overflow) return;
    let size = 64;
    try {
      size += JSON.stringify(data).length;
    } catch {
      /* size estimate only */
    }
    if (buf.events.length >= TURN_BUFFER_MAX_EVENTS || buf.bytes + size > TURN_BUFFER_MAX_BYTES) {
      buf.overflow = true;
      buf.events = [];
      buf.bytes = 0;
      return;
    }
    buf.events.push(data);
    buf.bytes += size;
  };
  c.appendTurnBufferFor = appendTurnBuffer;
  return c;
}


export function createAppContext(config) {
  const ctx = {
    // ── Config (parsed in server.js, the composition root) ──────────────────
    ...config,
    // Derived: forward-auth gate enabled (see server/auth.js). Optional SSO is
    // an identity overlay only and never enables the hard auth gate.
    authMode: config.AUTH_MODE || "none",
    authEnabled: config.AUTH_MODE === "forward_auth" || config.AUTH_MODE === "logto",
    ssoEnabled: config.AUTH_MODE !== "forward_auth" && config.AUTH_MODE !== "logto" && config.SSO_ENABLED === true,
    // Hosted-cell identity trust (see userFromHeaders in server/auth.js). Null
    // = reachability-only trust (dev, desktop, a proxy deployment). Set = the
    // cell honors identity headers only from a caller holding the gateway
    // secret, because on a shared host loopback binding is not a boundary.
    headerTrust: config.CLOUD_MODE ? { secret: config.CELL_GATEWAY_SECRET || "" } : null,
    // Bundle-manifest permissions splitter (extensions routes + MCP seeding).
    splitPolicy,

    // ── Service singletons ──────────────────────────────────────────────────
    chatHistory,
    documents,
    collections,
    db,
    migrate,
    cron,
    extensionStore,
    skillMaterialize,
    catalog,

    // Injected by server.js after express/http/wss are constructed.
    app: null,
    server: null,
    wss: null,
    upload: null,

    // ── Agent session state (see agent-session.js / initDshAgent) ───────────
    session: null,
    // ── Per-session web turn state (live-runtime-control D4) ─────────────────
    // Every streaming-scoped fact is keyed by the session it belongs to:
    // multiple chat sessions can hold a turn at once (dispatch concurrency),
    // while restart-carrying switches and idle-apply surfaces keep reading the
    // derived ANY-streaming view. `isStreaming` below stays a getter over this
    // map so every "is the runtime busy" read keeps its semantics.
    turnStateBySession: new Map(), // sid -> { isStreaming, origin, startedAt, error, toolNames, blocks, usage, promptStopped, currentTurnId }
    // Chat sessions the WEB path drives (beginTurnFor registers its target).
    // Event routing: a notification for one of these sessions goes to the web
    // machinery keyed by ITS sid even when the session manager points
    // elsewhere — that is what makes concurrent web turns visible at all.
    webTurnSessions: new Set(),
    // Subagent child sessions (subagent.started) — never web turns; their
    // turn/end error capture stays the only handling they get.
    subagentChildIds: new Set(),
    // Set only while a remote-agent fork is streaming. Session navigation can
    // abort that fetch; a local dsh turn has no interrupt RPC and is stopped by
    // restarting the bridge (see agent-session.js).
    activeRemoteTurnAbort: null,
    // Bumped after each session mutation so asynchronous session-list refreshes
    // from an older turn cannot overwrite the current sidebar state.
    sessionVersion: 0,
    // Active catalog agent: "local" = the local dsh session; any other id = a
    // catalog agent-remote (chat mode) entry that prompts are forked to.
    currentAgentId: "local",
    // The model the agent session starts on (set during async init; read by
    // the /api/supervisor/status route). This is the global default pointer,
    // not necessarily the model currently running for an optional SSO user.
    defaultModel: null,
    // Effective runtime state. In a hosted cell the cell's single user owns it
    // outright; in a shared-runtime deployment it reflects whoever last applied
    // a profile. `runtimeMcpOverlay` is the personal availability subtracted
    // from the global MCP set, so a global re-apply preserves it.
    runtimeModel: null,
    runtimeMcpOverlay: {},
    pendingBindings: new Map(),
    runtimeMutationChain: Promise.resolve(),
    // Active thinking level (null = the provider's default). Persisted per
    // provider in the prefs table; projected into settings.yaml by
    // dsh-profile.writeLlmProfile.
    currentEffort: null,
    // dsh bridge + session id.
    dshBridge: null,
    dshSessionId: null,
    // The selected dsh agent preset (agent mode). Persisted as the
    // `agent.preset` preference (read once the DB is ready in initDshAgent);
    // `standard` until then. Read by the WS preset handlers; applied to new
    // sessions through the bridge restart path.
    currentPreset: "standard",
    // The preset roster cache (`presets/list` from the bridge). Null until the
    // first successful fetch; the bridge itself caches per child generation,
    // so this is the last-seen copy for connect-time syncs.
    presetRoster: null,
    // The permission preset roster (composer control strip) + the current
    // session's effective preset, from the bridge's permissions/list
    // (add-permission-mode-selector). Null roster = not yet fetched; null
    // current = no session has pinned one yet (the bridge answers the
    // deployment default). Live switches arrive via the permission/preset
    // session-event translation in dsh-events.js.
    permissionOptions: [],
    currentPermission: null,
    // dsh MCP live-reload hook: REST routes mutate the DB, then call this to
    // rewrite the watched mcp.patch.yml so cordis HMR hot-swaps dsh-mcp-client
    // (no process restart). Assigned by initDshAgent.
    dshUpdateMcp: null,
    // The identity the effective profile is currently generated for (a cell's
    // user, or the last user whose bindings were applied). Resolves the
    // registry-credential lookup in writeMcpPatch; null = auth off / machine
    // owner. Set at boot and on every profile application. The groups snapshot
    // beside it is the filter the last application used, so a later rewrite
    // (e.g. a 401 marking the credential stale) reproduces it exactly.
    runtimeOwnerEmail: null,
    runtimeOwnerGroups: null,
    // Declared model list from the profile generator (initDshAgent populates
    // it; dsh exposes no stock listModels RPC, so this IS the model list).
    dshModels: [],
    // Latest `todo/write` plan snapshot per dsh session, normalized for the
    // wire (add-plan-progress-panel). Keyed by dsh session id so switching away
    // and back restores that session's plan. In-memory only: a server restart
    // starts with no plan, the same honesty class as the permission pin
    // reverting to the deployment default.
    planBySession: new Map(),
    // Pending user-question ask per dsh session (add-user-questions, ADR-0012):
    // {askId, questions, toolCallId?} from the child's `userQuestion/ask`
    // notification, held until the tool call resolves (its answer / cancel /
    // failure lands as the tool/result) or the runtime exits. Web sessions
    // only — bot-session asks route to their collectors and never land here.
    // This map is what rehydrates a card after a reload/reconnect.
    pendingQuestionBySession: new Map(),

    // ── Bot session collectors (design D2) ────────────────────────────────────
    // Per-session notification handlers for non-web chat sessions, keyed by
    // session id. Registered by the bot turn runner; cleared when the turn
    // completes. The session-aware event pump in dsh-events.js routes to these
    // instead of the WS broadcast path.
    sessionCollectors: new Map(),

    // ── WS clients + fan-out ────────────────────────────────────────────────
    clients: new Set(),

    // ── Readiness (listen-first boot; see server.js) ────────────────────────
    // The port listens immediately; agent-dependent features gate on dsh.
    ready: { dsh: false },
  };

  // ctx.finishTurn is attached by server/dsh-events.js (attachDshEvents).

  // A hosted cell without a gateway secret trusts nobody: every identity
  // header would be rejected, so the deployment would look authenticated-off
  // rather than fail loudly. Say so at boot.
  if (ctx.headerTrust && !ctx.headerTrust.secret) {
    console.warn("[auth] CLOUD_MODE is set without CELL_GATEWAY_SECRET — identity headers will never be trusted");
  }

  ctx.broadcast = (data) => {
    const msg = JSON.stringify(data);
    for (const ws of ctx.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
    }
  };

  // ── Per-viewer delivery (add-session-ownership) ───────────────────────────
  // Each connection tracks the session its client is viewing (ws.viewedSession,
  // maintained by server/ws.js). Turn events and session-scoped pushes go only
  // to the connections viewing that session — another user's transcript never
  // reaches a foreign client. Turn payloads carry the session id (additive
  // field; older clients ignore it). With auth off there is one user and one
  // view, so sendToViewers degenerates to today's broadcast semantics.
  const baseSendToViewers = (sessionId, data) => {
    if (!sessionId) return;
    const msg = JSON.stringify({ ...data, sessionId });
    for (const ws of ctx.clients) {
      if (ws.viewedSession !== sessionId) continue;
      if (ws.readyState !== ws.OPEN) continue;
      try {
        ws.send(msg);
      } catch {
        /* a dying socket must not fail the fan-out */
      }
    }
  };

  // ── In-flight turn replay buffer (add-reconnect-resync) ───────────────────
  // A turn's client view is a live event stream; the transcript persists only
  // at turn end, so a client that drops mid-run can never re-fetch the partial
  // from history. The server instead mirrors every run event it delivers (the
  // SAME choke point, so the log can never drift from what viewers saw) into a
  // bounded in-memory log, and switch_session's session_loaded answer carries
  // it (with running:true) so a reconnecting client rebuilds the turn and
  // continues live. Deliberately ephemeral: cleared when the turn ends, dropped
  // whole on overflow, never persisted — a miss just degrades the client to
  // keep-its-partial (converging at `done`).
  const TURN_BUFFERED_TYPES = new Set([
    "agent_start",
    "text",
    "thinking",
    "tool_start",
    "tool_update",
    "tool_end",
    "skill_use",
    "command_use",
    "retry_scheduled",
    "retry_started",
  ]);
  // Per-session turn state + replay buffers (D4) — one shared module; the
  // literal above seeds the collections, this call installs the helpers.
  attachTurnStateModule(ctx);
  ctx.sendToViewers = (sessionId, data) => {
    if (ctx.isStreamingFor(sessionId) && TURN_BUFFERED_TYPES.has(data?.type)) ctx.appendTurnBufferFor(sessionId, data);
    baseSendToViewers(sessionId, data);
  };

  // The session-list scope a connection is entitled to. Auth-off: undefined —
  // no scoping (the deployment IS one user; dev/desktop/e2e contract).
  // Auth-on: admin group sees everything, everyone else only their own rows.
  ctx.sessionScopeFor = (ws) => {
    if (!ctx.authEnabled) return undefined;
    if (ctx.isAdminUser?.(ws?.user)) return { includeAll: true };
    return { owner: ws?.user?.email ?? "" };
  };

  // Sessions-list refresh, computed per connection: each client gets its own
  // scope's list, and `current` names THAT connection's viewed session — not
  // the deployment-global live session, which may belong to another user.
  // One listSessions query per distinct scope per refresh tick.
  ctx.broadcastSessions = async () => {
    const version = ctx.sessionVersion;
    const scopeKey = (ws) => {
      const scope = ctx.sessionScopeFor(ws);
      return scope ? JSON.stringify(scope) : "*";
    };
    const lists = new Map();
    for (const key of new Set([...ctx.clients].map(scopeKey))) {
      try {
        lists.set(key, await chatHistory.listSessions(key === "*" ? undefined : JSON.parse(key)));
      } catch (e) {
        console.error("[sessions] scoped list failed:", e.message);
        lists.set(key, []);
      }
    }
    if (version !== ctx.sessionVersion) return;
    for (const ws of ctx.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const current = ws.viewedSession ?? (ctx.authEnabled ? null : chatHistory.currentSessionId());
      ctx.send(ws, { type: "sessions", sessions: lists.get(scopeKey(ws)) ?? [], current });
    }
  };

  // Turn origin (add-session-ownership design D2; per-session D4): the user +
  // session a turn was dispatched for, set synchronously at prompt dispatch,
  // consumed by the assistant-message mirror at turn completion. Lives in the
  // per-session turn state (ctx.turnStateFor(sid).origin) — the dsh event pump
  // resolves it from the event's own session id.

  ctx.send = (ws, data) => {
    if (ws?.readyState !== ws?.OPEN) return false;
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  };

  return ctx;
}
