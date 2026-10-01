// Chat store — single source of truth for the chat surface (web and
// mini program alike; the React binding lives with each consumer).
//
// Holds the imperative chat state: WS status, models, skills, sessions,
// streaming flag, the message list. One reducer function per incoming WS type
// via `apply()`.
//
// A "turn" is one user prompt + one assistant response. All server events that
// arrive between agent_start and done attach to the current assistant turn
// (thinking, tools, skill, text) — this is what removes the "sibling blocks"
// visual problem the vanilla app has.

import { create } from "zustand";
import { groupTurnBlocks, isGroupOpen } from "./activity-groups";
import type {
  AgentInfo,
  BindingModel,
  ChatMessage,
  McpBindingState,
  ModelInfo,
  PresetInfo,
  PermissionOption,
  RuntimeModel,
  ServerMessage,
  SessionMeta,
  SkillInfo,
  TodoCounts,
  TodoItem,
} from "../types/ws";

const NO_TODOS: TodoCounts = { pending: 0, inProgress: 0, completed: 0 };

export type ConnStatus = "connecting" | "connected" | "disconnected";

// Error surfacing is platform UI: the web wires a toast, the mini program a
// dialog/toast of its own. The default sink keeps the store usable (log only)
// when no consumer wires one.
let chatErrorSink: (message: string) => void = (message) => console.error("[chat]", message);
export function setChatErrorSink(fn: (message: string) => void) {
  chatErrorSink = fn;
}

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; open: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      state: "running" | "done" | "error";
      result?: unknown;
      partial?: unknown;
      open: boolean;
    }
  | { kind: "skill"; name: string; args?: string; open: boolean }
  | { kind: "command"; name: string; args?: string; message?: string; open: boolean }
  | { kind: "error"; message: string };

export type Turn =
  | { id: string; role: "user"; text: string; taskSummary?: boolean }
  | {
      id: string;
      role: "assistant";
      blocks: Block[];
      streaming: boolean;
      interrupted?: boolean;
      // User overrides per activity group (key = the group's start block
      // index; see activity-groups.ts). Absent = the derived default
      // (collapsed, except a group holding an errored tool). Ephemeral UI
      // state — never persisted.
      groupState?: Record<number, boolean>;
      // Client-side activity clock: set when the first non-text block is
      // pushed, closed when the first text block lands or the turn finalizes.
      // Powers the group header's duration; history-loaded turns have neither
      // and render the step count only.
      activityStartedAt?: number;
      activityEndedAt?: number;
    };

interface State {
  status: ConnStatus;
  models: ModelInfo[];
  currentModel: string | null;
  // Active thinking level; null = the provider default.
  currentEffort: string | null;
  agents: AgentInfo[];
  currentAgent: string | null;
  // Bumped on every `catalog_changed` so catalog-viewing pages refetch.
  catalogVersion: number;
  skills: SkillInfo[];
  // The dsh agent-preset roster (agent modes) and the selected one. Empty
  // roster = the deployment composes none, and the picker renders nothing.
  presets: PresetInfo[];
  currentPreset: string | null;
  // The permission preset table (sandbox + approval bundles) and the current
  // session's effective preset. Empty options = no permission service — the
  // strip control stays hidden. `currentPermission` renders from server state
  // only: the current_permission broadcast after a live switch, or the
  // permissions roster (whose current is the post-restart deployment default).
  permissionOptions: PermissionOption[];
  currentPermission: string | null;
  // Identity-scoped runtime bindings (optional SSO only). `userBindings` is the
  // requesting socket's own profile; `runtimeBinding` is the shared runtime the
  // one dsh child is actually configured with; `runtimePending` is a saved
  // profile waiting for an idle runtime.
  userBindings: { model: BindingModel | null; mcp: McpBindingState[] } | null;
  runtimeBinding: { model: RuntimeModel | null; mcp: { name: string; enabled: boolean }[] } | null;
  runtimePending: { model: RuntimeModel | null; mcp: { name: string; enabled: boolean }[] } | null;
  // Absolute path the dsh runtime is running in, plus previously used ones.
  currentWorkspace: string | null;
  workspaceRecents: string[];
  // Which composer control is awaiting the server's confirming broadcast.
  // dsh bakes model/effort/cwd/preset into the `initialize` handshake, so each
  // of these changes tears down and respawns the child — the send button stays
  // disabled until it lands. `agent` is the same switch for an agent the
  // deployment serves locally (a vertical pack is a persona preset).
  pendingConfig: "model" | "effort" | "workspace" | "preset" | "agent" | null;
  sessions: SessionMeta[];
  currentSessionId: string | null;
  turns: Turn[];
  // ── Optimistic session open (perf-session-open) ──────────────────────────
  // Non-null between an optimistic switch and the `session_loaded` that
  // resolves it (or the error/disconnect restore). The view renders the
  // pending skeleton while turns are empty, or the cached transcript when one
  // exists — the in-flight refresh reconciles via that same `session_loaded`.
  pendingSession: string | null;
  // True between sending `new_session` and its load. The new session's id is
  // minted server-side, so its load is recognized structurally: empty
  // messages for an id the client wasn't already viewing.
  pendingNewSession: boolean;
  // Latch flipped by the first activateSession/beginNewSession call. Clients
  // that never adopt the optimistic switch (mini program) keep the legacy
  // apply-every-load contract; adopted clients apply `session_loaded` only to
  // the view it names — stale or foreign loads feed the cache instead.
  optimisticSessions: boolean;
  // View snapshot for restoring when a pending switch fails (server `error`,
  // or the socket dropping mid-switch): what the user saw before the flip.
  sessionSwitchBackup: { id: string | null; turns: Turn[] } | null;
  // LRU of visited sessions' turns (cap SESSION_CACHE_CAP). Never rendered
  // from directly — activateSession copies an entry into `turns`; entries
  // refresh on applied loads and on `done` while viewing, and drop when the
  // session leaves the `sessions` list. In state (not module scope) only so
  // tests and the e2e seam can inspect it.
  sessionCache: Map<string, Turn[]>;
  // Optimistic activation: flip the view to the target immediately (pending
  // skeleton, or the cached transcript on re-entry), stash the outgoing view
  // for the failure restore, and fold the outgoing turns into the cache. The
  // WS send itself stays with the caller — the web's send choke point calls
  // this right before `switch_session` leaves.
  activateSession: (id: string) => void;
  // Arm the new-session handshake (see pendingNewSession). The view is NOT
  // flipped — a new chat has no target id to flip to; the empty load renders
  // the welcome when it lands, exactly as before.
  beginNewSession: () => void;
  isStreaming: boolean;
  // The agent's plan: the latest `todo/write` snapshot (replaced wholesale on
  // every write). It outlives turn boundaries by design — cleared only by a
  // new/loaded session, never by turn/start or turn/end. Empty = no plan, and
  // the plan surface renders nothing at all.
  todos: TodoItem[];
  todoCounts: TodoCounts;
  // True while the remainder of a dismissed run (user stop, or a socket drop
  // mid-stream) must be ignored. dsh has no interrupt RPC, so "stop" is a
  // view-level finalize; without this flag the orphaned run's late events
  // would open a fresh streaming turn and re-disable the composer.
  suppressed: boolean;
  // Demo quota end state (add-mp-demo-quota-end): set by the coded
  // demo_limit / sandbox_limit errors, cleared by the next accepted echo.
  // `shape` picks the recovery affordance — "cell" (per-cell budget, bind to
  // upgrade) vs "connection" (per-connection budget, reconnect to reset).
  demoExhausted: { shape: "cell" | "connection"; message: string } | null;
  // Remaining demo prompt budget after the last accepted echo; null when no
  // budget applies to this connection (bound accounts / non-demo shapes).
  demoBudgetLeft: number | null;
  // Cross-page composer handoff: a non-chat page (e.g. the library's "Start
  // conversation") parks a draft here before navigating to /chat; ChatPage
  // consumes it into its local draft on mount and clears it. Null = nothing
  // pending — a stale draft must never leak into a later visit.
  composerDraft: string | null;
  setComposerDraft: (text: string | null) => void;
  // Setters used by the WS hook.
  setStatus: (s: ConnStatus) => void;
  apply: (m: ServerMessage) => void;
  // Marks a config control as awaiting its server broadcast. Cleared by the
  // matching *_changed event, or by an error (the change was rejected). `agent`
  // covers a switch to a locally-served catalog agent (a vertical pack), which
  // applies its persona by restarting the runtime.
  setPendingConfig: (c: "model" | "effort" | "workspace" | "preset" | "agent" | null) => void;
  // Local UI commands (never sent to server).
  addUserTurnOptimistic: (text: string) => void;
  clearView: () => void;
  renameSession: (id: string, title: string) => void;
  toggleAllGroups: () => void;
  toggleGroup: (turnId: string, startIndex: number) => void;
  toggleBlock: (turnId: string, index: number) => void;
  // Release an in-flight run locally: finalize the open turn, give the
  // composer back, and swallow the run's remaining events until its `done`.
  stopStreaming: () => void;
}

let uid = 0;
const nextId = () => `t${++uid}`;

// Grab-or-create the currently open assistant turn. If the tail of `turns`
// isn't a streaming assistant, push a new one. When it IS, return a shallow
// CLONE substituted into the array: every block mutation below then writes to
// a fresh object, so the memoized <AssistantTurn> re-renders the tail (new
// prop reference) while every earlier turn keeps its reference and bails —
// O(1) per streamed delta. Mutating the tail in place would leave the memo
// comparing identical references and the streaming turn would never update.
function currentAssistant(turns: Turn[]): Turn & { role: "assistant" } {
  const tail = turns[turns.length - 1];
  if (tail && tail.role === "assistant" && tail.streaming) {
    const clone = { ...tail, blocks: tail.blocks.slice() };
    turns[turns.length - 1] = clone;
    return clone;
  }
  const fresh: Turn = { id: nextId(), role: "assistant", blocks: [], streaming: true };
  turns.push(fresh);
  return fresh;
}

// The activity clock: opens when the first non-text block lands on the turn,
// closes at the first text block (the answer started) or at turn finalization.
function markActivityStart(a: { activityStartedAt?: number }) {
  a.activityStartedAt ??= Date.now();
}

function markActivityEnd(a: { activityEndedAt?: number }) {
  a.activityEndedAt ??= Date.now();
}

// Append a text delta to the LAST text block on the current assistant turn,
// or create one. Thinking/tool/skill blocks in between force a fresh text
// block on the next text delta — matches server contract (text streams in
// segments broken by tool calls).
function appendText(turns: Turn[], delta: string) {
  const a = currentAssistant(turns);
  const last = a.blocks[a.blocks.length - 1];
  if (last?.kind === "text") {
    last.text += delta;
  } else {
    markActivityEnd(a);
    a.blocks.push({ kind: "text", text: delta });
  }
}

function appendThinking(turns: Turn[], delta: string) {
  const a = currentAssistant(turns);
  const last = a.blocks[a.blocks.length - 1];
  if (last?.kind === "thinking") {
    last.text += delta;
  } else {
    markActivityStart(a);
    a.blocks.push({ kind: "thinking", text: delta, open: true });
  }
}

// ── Streamed-delta batching ─────────────────────────────────────────────────
// Every text/thinking delta used to commit its own set(): a new turns array
// per token re-rendered the whole transcript and grew the streaming string
// quadratically. Deltas now accumulate in a small ordered segment list and
// flush as one commit at most every DELTA_FLUSH_MS. The ordered list — not
// two per-kind string slots — is what preserves arrival order: the
// reasoning→text boundary routinely lands inside one window, and a fixed
// text-before-thinking flush order rendered the reasoning tail AFTER the
// answer's opening, splitting one thinking pass into two blocks sandwiching
// the text. Any non-delta event first folds the pending buffer into the same
// set() call (tool blocks can never land before the text that preceded
// them), and session swaps / view clears discard the buffer (those deltas
// belong to the previous conversation).
const DELTA_FLUSH_MS = 50;
type PendingDelta = { kind: "text" | "thinking"; delta: string };
let pending: PendingDelta[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function queueDelta(kind: "text" | "thinking", delta: string) {
  const last = pending[pending.length - 1];
  if (last?.kind === kind) last.delta += delta;
  else pending.push({ kind, delta });
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      useChatStore.setState((state) => flushIntoTurns(state) ?? {});
    }, DELTA_FLUSH_MS);
  }
}

// Returns the turns patch for the buffered deltas (and clears the buffer),
// or null when nothing is pending. Called inside a set()/setState() updater.
function flushIntoTurns(state: State): { turns: Turn[] } | null {
  if (pending.length === 0) return null;
  const p = pending;
  pending = [];
  const turns = state.turns.slice();
  for (const seg of p) {
    if (seg.kind === "text") appendText(turns, seg.delta);
    else appendThinking(turns, seg.delta);
  }
  return { turns };
}

function discardDeltas() {
  pending = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

// Stream events that belong to one run. While `suppressed`, these are
// dropped; everything else (models, sessions, …) still applies.
const RUN_EVENT_TYPES = new Set([
  "agent_start",
  "text",
  "thinking",
  "tool_start",
  "tool_update",
  "tool_end",
  "skill_use",
  "command_use",
  "error",
]);

// Close every open assistant turn. Returns a NEW array (no in-place mutation —
// callers run inside set()).
function finalizeOpenTurns(turns: Turn[]): Turn[] {
  const now = Date.now();
  return turns.map((t) =>
    t.role === "assistant" && t.streaming
      ? { ...t, streaming: false, activityEndedAt: t.activityEndedAt ?? now }
      : t,
  );
}

// ── Session turn cache (perf-session-open) ───────────────────────────────────
// Small LRU of visited sessions' rendered turns. Map order IS the recency
// order: writes delete-then-set so the entry lands at the MRU end, and
// eviction removes the first (least recently used) key over the cap.
const SESSION_CACHE_CAP = 10;

function cacheWrite(
  cache: Map<string, Turn[]>,
  id: string,
  turns: Turn[],
): Map<string, Turn[]> {
  if (turns.length === 0) {
    // An empty transcript is the welcome state — nothing to memoize, and
    // keeping it would only push real sessions out of the LRU.
    if (!cache.has(id)) return cache;
    const next = new Map(cache);
    next.delete(id);
    return next;
  }
  const next = new Map(cache);
  next.delete(id);
  next.set(id, turns);
  while (next.size > SESSION_CACHE_CAP) next.delete(next.keys().next().value as string);
  return next;
}

// Snapshot a live view for stash (backup + cache): streaming turns close as
// interrupted — the server stops the run on switch, so an unfinished answer
// must never read as complete, here or on later cached re-entry.
function snapshotTurns(turns: Turn[]): Turn[] {
  const now = Date.now();
  return turns.map((t) =>
    t.role === "assistant" && t.streaming
      ? { ...t, streaming: false, interrupted: true, activityEndedAt: t.activityEndedAt ?? now }
      : t,
  );
}

export const useChatStore = create<State>((set) => ({
  status: "connecting",
  models: [],
  currentModel: null,
  currentEffort: null,
  agents: [],
  currentAgent: null,
  catalogVersion: 0,
  skills: [],
  presets: [],
  currentPreset: null,
  permissionOptions: [],
  currentPermission: null,
  userBindings: null,
  runtimeBinding: null,
  runtimePending: null,
  currentWorkspace: null,
  workspaceRecents: [],
  pendingConfig: null,
  sessions: [],
  currentSessionId: null,
  turns: [],
  pendingSession: null,
  pendingNewSession: false,
  optimisticSessions: false,
  sessionSwitchBackup: null,
  sessionCache: new Map(),

  activateSession: (id) =>
    set((state) => {
      // The optimistic flip is only sound on a live socket — a switch whose
      // load can't come back would strand the pending skeleton.
      if (useChatStore.getState().status !== "connected") return {};
      discardDeltas();
      // The outgoing view feeds the cache (finalized — see snapshotTurns).
      const cache =
        state.currentSessionId && state.turns.length > 0
          ? cacheWrite(
              state.sessionCache,
              state.currentSessionId,
              snapshotTurns(state.turns),
            )
          : state.sessionCache;
      const cached = cache.get(id);
      // Only the FIRST snapshot of a rapid click chain survives: A→B→C before
      // any load lands restores A — the last view the user actually had.
      const backup =
        state.sessionSwitchBackup ?? { id: state.currentSessionId, turns: snapshotTurns(state.turns) };
      return {
        optimisticSessions: true,
        sessionSwitchBackup: backup,
        currentSessionId: id,
        pendingSession: id,
        // A switch supersedes an in-flight +New, but pendingNewSession stays
        // armed: if that new session's load is still behind this one in the
        // socket's ordering, it must keep its structural apply path.
        pendingNewSession: state.pendingNewSession,
        // Cached re-entry renders instantly; a miss clears to the skeleton.
        turns: cached ?? [],
        isStreaming: false,
        todos: [],
        todoCounts: NO_TODOS,
        // Re-entry is itself a use — bump recency.
        sessionCache: cached ? cacheWrite(cache, id, cached) : cache,
      };
    }),

  beginNewSession: () =>
    set((state) => {
      if (useChatStore.getState().status !== "connected") return {};
      return {
        optimisticSessions: true,
        pendingNewSession: true,
        pendingSession: null,
        sessionSwitchBackup:
          state.sessionSwitchBackup ?? {
            id: state.currentSessionId,
            turns: snapshotTurns(state.turns),
          },
      };
    }),
  isStreaming: false,
  todos: [],
  todoCounts: NO_TODOS,
  suppressed: false,
  demoExhausted: null,
  demoBudgetLeft: null,
  composerDraft: null,

  setComposerDraft: (text) => set({ composerDraft: text }),

  setPendingConfig: (c) => set({ pendingConfig: c }),

  setStatus: (s) =>
    set((state) => {
      if (s !== "disconnected") return { status: s };
      // Only a live socket can strand a run. A socket that never connected —
      // gated off while the auth check runs, so every page load passes through
      // here — has no in-flight turn to finalize, and must not arm `suppressed`
      // (that would swallow the next server-initiated run: a cron-fired prompt
      // has no `user` echo to clear it).
      if (state.status !== "connected") return { status: s };
      // A dropped socket used to strand `isStreaming` forever (only
      // done/session_loaded/clearView reset it) — the composer bricked until
      // the view was wiped. Finalize the open turn and suppress the orphaned
      // run's remaining events instead; the connection banner explains the
      // socket while the WS hook reconnects, and the interrupted marker on
      // the turn itself says the ANSWER was cut off (indistinguishable from
      // a finished one before this).
      discardDeltas();
      // A socket drop mid-switch is a failed switch (perf-session-open): put
      // the displaced view back rather than leave a skeleton over a dead
      // socket. The banner carries the story; the URL still names the target.
      if (state.pendingSession || state.pendingNewSession) {
        const b = state.sessionSwitchBackup;
        return {
          status: s,
          currentSessionId: b ? b.id : state.currentSessionId,
          turns: b ? b.turns : state.turns,
          isStreaming: false,
          suppressed: true,
          pendingSession: null,
          pendingNewSession: false,
          sessionSwitchBackup: null,
        };
      }
      return {
        status: s,
        turns: snapshotTurns(state.turns),
        isStreaming: false,
        suppressed: true,
      };
    }),

  apply: (m) => {
    // A dismissed run's stream events are swallowed until the run's own
    // `done` (or the next prompt's `user` echo) clears the flag. Checked
    // before queueDelta so buffered text can't leak past the suppression.
    // Exception: an error that arrives while a session switch is pending is
    // the switch's own refusal, never the dismissed run's — it must reach
    // the restore path (perf-session-open).
    if (
      useChatStore.getState().suppressed &&
      RUN_EVENT_TYPES.has(m.type) &&
      !(m.type === "error" && (useChatStore.getState().pendingSession || useChatStore.getState().pendingNewSession))
    )
      return;
    // Streamed deltas are buffered (see DELTA_FLUSH_MS above) — no commit
    // per token.
    if (m.type === "text" || m.type === "thinking") {
      queueDelta(m.type, m.delta);
      return;
    }
    // A session swap discards buffered deltas (previous conversation); every
    // other message folds them in first, preserving event order exactly.
    if (m.type === "session_loaded") discardDeltas();

    set((state) => {
      const pre = flushIntoTurns(state);
      const turns = pre ? pre.turns : state.turns.slice();
      switch (m.type) {
        case "user":
          turns.push({
            id: nextId(),
            role: "user",
            text: m.text,
            // The delegation aggregator's summary turn arrives as a user echo
            // with the taskSummary flag — clients style it task-authored.
            ...(m.taskSummary ? { taskSummary: true } : {}),
          });
          // A new prompt's echo ends any suppression from a prior stop, and
          // an accepted prompt proves the quota has recovered (fresh
          // connection or new budget) — carry the count when the server
          // reports one (demo shapes only).
          return {
            turns,
            suppressed: false,
            demoExhausted: null,
            ...(typeof m.budgetLeft === "number" ? { demoBudgetLeft: m.budgetLeft } : {}),
          };

        case "agent_start":
          // Fresh assistant turn only when there isn't already an open one.
          currentAssistant(turns);
          return { turns, isStreaming: true };

        case "tool_start": {
          const a = currentAssistant(turns);
          markActivityStart(a);
          a.blocks.push({
            kind: "tool",
            id: m.toolCallId,
            name: m.name,
            args: m.args,
            state: "running",
            open: false,
          });
          return { turns };
        }

        case "tool_update": {
          const a = currentAssistant(turns);
          const b = a.blocks.find(
            (x): x is Extract<Block, { kind: "tool" }> =>
              x.kind === "tool" && x.id === m.toolCallId,
          );
          if (b) b.partial = m.partialResult;
          return { turns };
        }

        case "tool_end": {
          const a = currentAssistant(turns);
          const b = a.blocks.find(
            (x): x is Extract<Block, { kind: "tool" }> =>
              x.kind === "tool" && x.id === m.toolCallId,
          );
          if (b) {
            b.state = m.isError ? "error" : "done";
            b.result = m.result;
            if (m.isError) {
              b.open = true;
              // The enclosing activity group must not hide the failure: mark
              // it open (an explicit user collapse later still wins, since
              // this writes the same override it reads).
              const idx = a.blocks.indexOf(b);
              const containing = groupTurnBlocks(a.blocks).find(
                (g) => g.startIndex <= idx && idx < g.startIndex + g.blocks.length,
              );
              if (containing) a.groupState = { ...a.groupState, [containing.startIndex]: true };
            }
          }
          return { turns };
        }

        case "skill_use": {
          const a = currentAssistant(turns);
          markActivityStart(a);
          a.blocks.push({ kind: "skill", name: m.name, args: m.args, open: false });
          return { turns };
        }

        case "command_use": {
          // A command echo is the user-invoked action's whole feedback — it
          // renders outside activity groups and opens no activity clock.
          const a = currentAssistant(turns);
          a.blocks.push({
            kind: "command",
            name: m.name,
            args: m.args,
            message: m.message,
            open: true,
          });
          return { turns };
        }

        case "done": {
          const tail = turns[turns.length - 1];
          // Clone (not mutate): the finalized turn needs a new reference so
          // the memoized <AssistantTurn> re-renders its closed state.
          if (tail && tail.role === "assistant" && tail.streaming) {
            markActivityEnd(tail);
            turns[turns.length - 1] = { ...tail, streaming: false };
          }
          // The dismissed run (if any) has ended; stop swallowing events.
          // Turn events carry no session id pre-targeted-delivery, so the
          // conservative cache rule applies: a `done` while viewing S
          // refreshes S's entry only — the completed turn is the final state
          // a later cached re-entry of S should render (perf-session-open).
          return state.currentSessionId && turns.length > 0
            ? {
                turns,
                isStreaming: false,
                suppressed: false,
                sessionCache: cacheWrite(state.sessionCache, state.currentSessionId, turns),
              }
            : { turns, isStreaming: false, suppressed: false };
        }

        case "error": {
          // The designed quota end (add-mp-demo-quota-end) is a terminal
          // state, not an error to toast: route the coded shapes into
          // demoExhausted so the owning view can render the end-state card.
          // The pending-config clear matches the generic branch below — a
          // rejected change never gets its confirming broadcast.
          if (m.code === "demo_limit" || m.code === "sandbox_limit") {
            return {
              demoExhausted: {
                shape: m.code === "demo_limit" ? "cell" : "connection",
                message: m.message,
              },
              pendingConfig: null,
            };
          }
          // An error with no run in flight (e.g. "Agent is still
          // initializing" broadcast during cold boot, or a rejected
          // concurrent prompt) must not fabricate an empty assistant turn —
          // surface it through the platform error sink instead. Errors
          // during a live run still attach to that turn (as a clone, so the
          // turn re-renders).
          const tail = turns[turns.length - 1];
          if (!tail || tail.role !== "assistant" || !tail.streaming) {
            chatErrorSink(m.message);
            // A failed session switch (unknown id, dsh busy, ownership
            // refusal) reports as a sink-level error while its optimistic
            // flip is still unresolved: restore the view the flip displaced
            // (perf-session-open) — the toast carries the failure.
            if (state.pendingSession || state.pendingNewSession) {
              const b = state.sessionSwitchBackup;
              return {
                pendingConfig: null,
                pendingSession: null,
                pendingNewSession: false,
                sessionSwitchBackup: null,
                currentSessionId: b ? b.id : state.currentSessionId,
                turns: b ? b.turns : turns,
              };
            }
            // A rejected config change (bad path, agent busy) never sends its
            // confirming *_changed broadcast, so the pending control would hang forever.
            return { pendingConfig: null };
          }
          turns[turns.length - 1] = {
            ...tail,
            blocks: [...tail.blocks, { kind: "error", message: m.message }],
          };
          return { turns };
        }

        case "current_model":
        case "model_changed":
          // `effort` is omitted on payloads that don't touch it; only overwrite
          // the level when the server actually reported one.
          return m.effort === undefined
            ? { currentModel: m.id, pendingConfig: null }
            : { currentModel: m.id, currentEffort: m.effort, pendingConfig: null };

        case "effort_changed":
          return { currentEffort: m.effort, pendingConfig: null };

        case "workspaces":
          return { currentWorkspace: m.current, workspaceRecents: m.recents };

        case "workspace_changed":
          return {
            currentWorkspace: m.path,
            // Server-side LRU order is authoritative, but keeping the head in
            // sync locally avoids a round-trip before the popover reopens.
            workspaceRecents: [m.path, ...state.workspaceRecents.filter((p) => p !== m.path)],
            pendingConfig: null,
          };

        case "models":
          return { models: m.models };

        case "current_agent":
          return { currentAgent: m.id };

        case "agent_changed":
          return { currentAgent: m.id, pendingConfig: null };

        case "agents":
          return { agents: m.agents };

        case "catalog_changed":
          return { catalogVersion: state.catalogVersion + 1 };

        case "skills":
          return { skills: m.skills };

        case "presets":
          return { presets: m.presets, currentPreset: m.current };

        case "permissions":
          return { permissionOptions: m.options, currentPermission: m.current };

        case "current_permission":
          return { currentPermission: m.name };

        case "todos":
          // Whole-list replacement, live write and rehydration push alike.
          // Counts come from the server so header rendering needs no recount.
          return { todos: m.todos, todoCounts: m.counts };

        case "current_preset":
          return { currentPreset: m.id, pendingConfig: null };

        case "sessions": {
          // Delete invalidation (perf-session-open): a session that left the
          // list was deleted — its cached turns must not survive a re-click
          // of a stale row. The list is the same user-scoped payload the
          // sidebar groups, so every cache key is accountable to it.
          let sessionCache = state.sessionCache;
          for (const id of state.sessionCache.keys()) {
            if (!m.sessions.some((s) => s.id === id)) {
              if (sessionCache === state.sessionCache) sessionCache = new Map(sessionCache);
              sessionCache.delete(id);
            }
          }
          return {
            sessions: m.sessions,
            currentSessionId: m.current ?? state.currentSessionId,
            sessionCache,
          };
        }

        case "session_changed":
          return { currentSessionId: m.id };

        case "session_renamed":
          return {
            sessions: state.sessions.map((s) => (s.id === m.id ? { ...s, title: m.title } : s)),
          };

        case "session_loaded": {
          const mapped = (m.messages || []).map<Turn>((msg: ChatMessage) =>
            msg.role === "user"
              ? {
                  id: nextId(),
                  role: "user",
                  text: msg.content,
                  // The delegation aggregator's injected summaries carry a
                  // leading task_summary block — keep the styling on reload.
                  ...(msg.blocks?.[0]?.kind === "task_summary" ? { taskSummary: true } : {}),
                }
              : {
                  id: nextId(),
                  role: "assistant",
                  // Restore the persisted block structure when present (tool
                  // calls intact, collapsed — an errored one stays open, as it
                  // streamed); plain content is the legacy fallback for
                  // pre-migration rows. Reasoning is deliberately NOT persisted
                  // (see chat-history recordMessage), so a reloaded turn is the
                  // answer plus the tools that produced it.
                  blocks: msg.blocks?.length
                    ? msg.blocks.map((b) =>
                        b.kind === "tool"
                          ? {
                              kind: "tool" as const,
                              id: b.id,
                              name: b.name,
                              args: b.args,
                              result: b.result,
                              state: b.state ?? ("done" as const),
                              open: b.state === "error",
                            }
                          : // task_summary markers (user-message injected turns)
                            // and text blocks: keep the text, drop the marker —
                            // the flag on the user turn carries the styling.
                            { kind: "text" as const, text: b.kind === "text" ? b.text : "" },
                      )
                    : [{ kind: "text", text: msg.content }],
                  streaming: false,
                },
          );
          // The new-session handshake resolves on structure, not id: the id
          // was minted server-side, and the load that carries it is empty and
          // for a session the client wasn't viewing.
          const isNewChatArrival =
            state.pendingNewSession && mapped.length === 0 && m.id !== state.currentSessionId;
          // Stale/foreign load guard (perf-session-open): on a client that
          // adopted the optimistic switch, `session_loaded` replaces the view
          // only when it names the session the client views (or completes an
          // armed +New). Everything else — a superseded switch racing a newer
          // one, another viewer's load of a session this client still
          // server-views — feeds the cache and leaves the view alone.
          // Pessimistic clients keep the legacy apply-everything contract.
          const applies =
            !state.optimisticSessions || isNewChatArrival || m.id === state.currentSessionId;
          if (!applies) {
            return { sessionCache: cacheWrite(state.sessionCache, m.id, mapped) };
          }
          return {
            currentSessionId: m.id,
            turns: mapped,
            isStreaming: false,
            suppressed: state.suppressed,
            // A plan belongs to its session: clear on load, then the server's
            // snapshot push (when the target session has one) repopulates it.
            todos: [],
            todoCounts: NO_TODOS,
            pendingSession: null,
            // Only the structural new-chat arrival consumes the handshake —
            // an id-matched refresh must not disarm it while the real
            // new-session load is still in flight behind this one.
            pendingNewSession: isNewChatArrival ? false : state.pendingNewSession,
            sessionSwitchBackup: null,
            sessionCache: cacheWrite(state.sessionCache, m.id, mapped),
          };
        }

        case "user_bindings":
          return { userBindings: { model: m.model, mcp: m.mcp } };

        case "runtime_binding":
          return { runtimeBinding: { model: m.model, mcp: m.mcp }, runtimePending: null };

        case "runtime_binding_pending":
          return { runtimePending: { model: m.model, mcp: m.mcp } };

        // Non-chat channels. Ignored for now — the owning views/stores
        // subscribe to these themselves (e.g. useExtensionsStore.applyEvent
        // handles extensions_changed).
        case "cron_jobs":
        case "cron_status":
        case "cron_removed":
        case "cron_fired":
        case "cron_completed":
        case "cron_added":
        case "cron_paused":
        case "cron_resumed":
        case "cron_run_started":
        case "dashboard_update":
        case "dashboard_state":
        case "documents_status":
        case "extensions_changed":
          return {};

        default:
          // CRITICAL: never fall through returning undefined. Zustand treats a
          // non-object partial as a FULL state replacement, so an unhandled
          // message type would blank the whole store and crash every
          // subscriber on the next render ("Cannot read properties of
          // undefined"). Ignore unknown types instead.
          return {};
      }
    });
  },

  addUserTurnOptimistic: (text) => {
    // Fold any buffered assistant deltas first so the optimistic user turn
    // lands after them in the transcript.
    set((state) => {
      const pre = flushIntoTurns(state);
      const turns = pre ? pre.turns : state.turns;
      return { turns: [...turns, { id: nextId(), role: "user", text }] };
    });
  },

  // Optimistic local rename; the broadcast `session_renamed` event reconciles
  // every other open client (and ours, in case the server's value trims).
  renameSession: (id, title) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
    })),

  clearView: () => {
    discardDeltas();
    set((state) => ({
      turns: [],
      isStreaming: false,
      suppressed: state.suppressed || state.isStreaming,
      todos: [],
      todoCounts: NO_TODOS,
    }));
  },

  stopStreaming: () => {
    // dsh's wire protocol has no interrupt RPC (initialize / session/prompt /
    // shutdown only), so stop is local: close the turn where it stands, hand
    // the composer back, and swallow the run's remaining events until `done`.
    set((state) => {
      discardDeltas();
      return {
        turns: finalizeOpenTurns(state.turns),
        isStreaming: false,
        suppressed: true,
      };
    });
  },

  toggleAllGroups: () =>
    set((state) => {
      // Flip all activity groups to the OPPOSITE of the majority state (if
      // any is closed, opening all reads as the natural intent). The inner
      // per-block collapse states are not touched — the shortcut drives the
      // master fold only.
      let anyClosed = false;
      const groupsByTurn = state.turns.map((t) => {
        if (t.role !== "assistant") return null;
        const gs = groupTurnBlocks(t.blocks);
        for (const g of gs) if (!isGroupOpen(t, g)) anyClosed = true;
        return gs;
      });
      const target = anyClosed;
      const turns = state.turns.map((t, i) => {
        const gs = groupsByTurn[i];
        if (t.role !== "assistant" || !gs || gs.length === 0) return t;
        const groupState = { ...t.groupState };
        for (const g of gs) groupState[g.startIndex] = target;
        return { ...t, groupState };
      });
      return { turns };
    }),

  toggleGroup: (turnId, startIndex) =>
    set((state) => ({
      turns: state.turns.map((t) => {
        if (t.id !== turnId || t.role !== "assistant") return t;
        const group = groupTurnBlocks(t.blocks).find((g) => g.startIndex === startIndex);
        if (!group) return t;
        return { ...t, groupState: { ...t.groupState, [startIndex]: !isGroupOpen(t, group) } };
      }),
    })),

  toggleBlock: (turnId, index) =>
    set((state) => ({
      turns: state.turns.map((t) => {
        if (t.id !== turnId || t.role !== "assistant") return t;
        return {
          ...t,
          blocks: t.blocks.map((b, i) => {
            if (i !== index) return b;
            if (b.kind === "text" || b.kind === "error") return b;
            return { ...b, open: !b.open };
          }),
        };
      }),
    })),
}));

// Dev/test seam: expose the store to the host environment's global (the web's
// window.__chatStore, gated to dev/e2e builds by the caller). Kept behind an
// injected exposer so this module stays environment-free.
export function setStoreExposer(expose: ((store: typeof useChatStore) => void) | null) {
  expose?.(useChatStore);
}
