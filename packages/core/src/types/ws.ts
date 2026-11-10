// WebSocket message types.
//
// Source of truth for what the Node backend broadcasts and accepts. Mirrors
// server.js. When server.js grows a new type, add it here — the React store's
// exhaustive switch will fail to compile until the case is handled.

// ── Server → client ─────────────────────────────────────────────────────────

// A replayable in-flight turn event (add-reconnect-resync): one wire message
// from the run-scoped subset the server buffers for reconnect replay. Same
// shapes the live stream delivers; replayed through the same store fold.
export type TurnEvent = Extract<
  ServerMessage,
  {
    type:
      | "agent_start"
      | "text"
      | "thinking"
      | "tool_start"
      | "tool_update"
      | "tool_end"
      | "skill_use"
      | "command_use"
      | "retry_scheduled"
      | "retry_started";
  }
>;

// Run-scoped messages carry the emitting session as an additive `sessionId`
// field (stamped by the server's per-viewer delivery). Clients use it to drop
// events for a session they are not viewing; older payloads without it still
// apply (field presence gates the check).
export type RunScopedMessage = Extract<
  ServerMessage,
  { type: TurnEvent["type"] | "user" | "done" }
> & { sessionId?: string };

// Where to fix a credential-shaped failure (chat-connect-guidance): the
// connections-panel id whose card repairs it. Absent = not credential-shaped.
export type ConnectPointer = { panel: string };

export type ServerMessage =
  | { type: "user"; text: string; budgetLeft?: number; taskSummary?: boolean; sessionId?: string }
  | ({ type: "agent_start" } & { sessionId?: string })
  | ({ type: "text"; delta: string } & { sessionId?: string })
  | ({ type: "thinking"; delta: string } & { sessionId?: string })
  | ({ type: "tool_start"; toolCallId: string; name: string; args: unknown } & { sessionId?: string })
  | ({ type: "tool_update"; toolCallId: string; name: string; partialResult: unknown } & { sessionId?: string })
  | ({ type: "tool_end"; toolCallId: string; name?: string; result: unknown; isError?: boolean; connect?: ConnectPointer } & { sessionId?: string })
  | ({ type: "skill_use"; name: string; args?: string } & { sessionId?: string })
  | ({ type: "command_use"; name: string; args?: string; message?: string } & { sessionId?: string })
  | ({ type: "done" } & {
      sessionId?: string;
      // Turn token usage (chat-usage-display): the LAST step's numbers (dsh
      // attaches TokenUsage to assistant/message, one per model request) —
      // input is the session's live context size. Absent when the runtime
      // reported none (older servers / usage-less turns).
      usage?: { inputTokens: number; outputTokens: number };
    })
  // Bounded model-request retry progress (add-llm-retry-resilience): a
  // transient failure was scheduled for retry (normal mode carries the finite
  // budget), and the wait elapsed with the next attempt starting. Status
  // indications for the open turn — never assistant content.
  | {
      type: "retry_scheduled";
      retryId: string | null;
      provider: string | null;
      mode: string;
      retry: number | null;
      maxRetries?: number;
      delayMs: number | null;
      failure: { code: string | null; message: string | null };
    }
  | { type: "retry_started"; retryId: string | null; retry: number | null }
  // `code` carries the machine-readable shape when the error is a designed
  // terminal condition (demo_limit / sandbox_limit — add-mp-demo-quota-end).
  | { type: "error"; message: string; code?: string; connect?: ConnectPointer }
  | { type: "current_model"; id: string | null; effort?: string | null }
  | {
      type: "models";
      models: ModelInfo[];
      // Live-control flags (live-runtime-control): which custom bridge RPCs
      // the current child answers. Absent on older servers = all false.
      live?: { modelSet: boolean; cancel: boolean; toolGate: boolean };
    }
  // Per-session MCP server gate state (live-runtime-control tools/set):
  // pushed on toggle and after every session load so each client's web-search
  // chip shows the session's real position (default closed).
  | { type: "tool_gate"; sessionId: string; server: string; enabled: boolean }
  | { type: "model_changed"; id: string | null; effort?: string | null }
  // Default-lane guard (add-editable-llm-route): the default model was dark at
  // probe time and the pointer fell back to `to`.
  | { type: "model_fallback"; from: string; to: string; reason?: string }
  | { type: "effort_changed"; effort: string | null }
  | { type: "workspaces"; current: string | null; recents: string[] }
  | { type: "workspace_changed"; path: string }
  | { type: "agents"; agents: AgentInfo[] }
  | { type: "current_agent"; id: string }
  | { type: "agent_changed"; id: string }
  | { type: "presets"; presets: PresetInfo[]; current: string }
  | { type: "current_preset"; id: string }
  | { type: "permissions"; options: PermissionOption[]; current: string | null }
  | { type: "current_permission"; name: string }
  // dsh plugin supply (add-dsh-plugin-supply): the profile's whitelisted
  // bundle roster and its post-apply pulse. `available:false` means the child
  // is not ready or the bridge call failed — `bundles` is then the last known
  // snapshot.
  | { type: "plugins"; bundles: PluginBundleInfo[]; available: boolean }
  | { type: "plugins_changed"; bundles: PluginBundleInfo[] }
  | { type: "todos"; todos: TodoItem[]; counts: TodoCounts }
  // A pending user-question ask (add-user-questions): broadcast when the
  // runtime parks on ask_user_question, re-pushed on reconnect/session sync
  // while it waits. `toolCallId` anchors the interactive card to its
  // transcript block. The ask resolves through its own tool_end (answer,
  // cancellation, or failure — that block's result is the summary), which is
  // also what clears the pending state client-side.
  | {
      type: "agent_question";
      askId: string;
      toolCallId?: string;
      questions: AskQuestionItem[];
      sessionId?: string;
    }
  | { type: "answer_question_error"; message: string }
  | { type: "catalog_changed" }
  | { type: "skills"; skills: SkillInfo[] }
  | { type: "documents_status"; [k: string]: unknown }
  // Resource library consistency (openspec: add-resource-library): emitted on
  // capture/save/rename/delete; clients refetch their current query rather than
  // patching. `resourceType` is the RESOURCE's kind ("chart" | "file") — `type`
  // is taken by the message discriminator.
  | { type: "resources_changed"; action: "created" | "renamed" | "deleted"; id: string; resourceType: string }
  | { type: "sessions"; sessions: SessionMeta[]; current?: string }
  // A prompt was accepted while the runtime is busy (concurrent-chat-sessions).
  // Sent to the session's viewers before any user echo — a queued prompt is not
  // yet history. `waitingOn` names the web session whose turn is open, or null
  // when the runtime is busy on a non-web lane (a scheduled task or a bot).
  | { type: "queued"; sessionId: string; text: string; position: number; waitingOn: { id: string; title: string | null } | null }
  // The queue entry resolved: "dispatched" hands off to the normal user echo →
  // agent_start sequence; "cancelled" means it never ran (the client hands the
  // text back to the composer).
  | { type: "dequeued"; sessionId: string; reason: "dispatched" | "cancelled" }
  | { type: "session_changed"; id: string }
  | {
      type: "session_loaded";
      id: string;
      title?: string;
      messages: ChatMessage[];
      // Windowed transcript (polish-web-surfaces, web-chat-server): the first
      // frame carries at most the tail window. `totalTurns` is the session's
      // full persisted count and `hasMore` says whether earlier messages remain
      // to page in. Absent on older servers — the client then treats the
      // received list as complete (today's behavior).
      totalTurns?: number;
      hasMore?: boolean;
      // Reconnect resync (add-reconnect-resync): a turn is in flight for this
      // session. With `turnEvents` the client rebuilds the open turn by
      // folding the server's replay log; without it (buffer miss — overflow
      // or process restart) it keeps its local partial and continues live.
      // Absent on older servers — the transcript replace then applies as
      // before.
      running?: boolean;
      turnEvents?: TurnEvent[];
      // A prompt is queued behind another session's turn
      // (concurrent-chat-sessions): the client restores the pending bubble from
      // this instead of from the transcript, since a queued prompt is never a
      // history row. Absent/null = nothing queued for this session.
      queued?: QueuedTurn | null;
      // Fresh-session marker (chat-input-focus): the load carries a session
      // created by THIS requester's action (New chat / /new). Absent on every
      // other load — switches, resyncs, other viewers' views.
      created?: boolean;
    }
  // A page of earlier transcript (polish-web-surfaces): the answer to
  // `load_earlier`, ascending, with whether even older messages remain.
  | { type: "session_page"; id: string; messages: ChatMessage[]; hasMore: boolean }
  | { type: "session_renamed"; id: string; title: string }
  | { type: "cron_jobs"; jobs: CronJob[] }
  | { type: "cron_status"; job: CronJob }
  | { type: "cron_removed"; id: string }
  | { type: "cron_fired"; id: string; prompt: string; state?: string }
  | { type: "cron_completed"; id: string; success?: boolean; state?: string; error?: string; completedAt?: string }
  | { type: "cron_added"; job: CronJob }
  | { type: "cron_updated"; job: CronJob }
  | { type: "cron_paused"; jobId: string; success: boolean }
  | { type: "cron_resumed"; jobId: string; success: boolean }
  | { type: "cron_run_started"; jobId: string; success: boolean; state?: string; already?: boolean; message?: string }
  // Rejected cron action (e.g. invalid cron expression in cron_add) — scoped
  // to the action so it can render in the owning view instead of a toast.
  | { type: "cron_error"; action: string; message: string }
  // Fleet run ledger (agent-fleet-runs, add-fleet-cockpit-v2): live turn and
  // run lifecycle for the cockpit canvas. started/ended carry the chain
  // position (parentTurnId × edgeKind; null on a root); runUpdated fires on
  // header open and every close. Fleet-domain fields only — ids, outcome,
  // timing; never a credential, never a session body.
  | { type: "fleet_turn_started"; fleetId: string; memberId: string; runId: string; turnId: string; parentTurnId: string | null; parentMemberId: string | null; edgeKind: string | null; source: string; sessionId: string | null; startedAt: number }
  | { type: "fleet_turn_ended"; fleetId: string; memberId: string; runId: string; turnId: string; parentTurnId: string | null; parentMemberId: string | null; edgeKind: string | null; source: string; sessionId: string | null; startedAt: number; endedAt: number; status: string | null; errorKind: string | null; model: string | null; usage: { input: number | null; output: number | null } | null }
  | { type: "fleet_run_updated"; run: FleetRunSummary }
  // Cluster session binding (agent-cluster-platform): a dynamic cluster was
  // attached to a session (header shows the cluster; messages run under the
  // lead agent), and a bound cluster was terminated (the session falls back
  // to the built-in agent with a notification).
  | { type: "cluster_bound"; clusterId: string; clusterName: string; sessionId: string }
  | { type: "cluster_terminated"; clusterId: string; clusterName: string; sessionId: string }
  // Auto-termination warning (1h grace): a bound cluster that is about to
  // expire shows it on its chip; using it during the grace period keeps it.
  | { type: "cluster_expiring"; clusterId: string; clusterName: string; terminatesAt: number }
  | { type: "dashboard_update"; state: unknown }
  | { type: "dashboard_state"; state: unknown }
  | { type: "extensions_changed"; resource: string; action: string; name: string; enabled?: boolean }
  | { type: "market_changed" }
  // A role's focus overlay was adjusted (deployment-global, add-focus-overlay):
  // every client refetches the role's effective set from /api/agent/overlay.
  // `overlay` is null when the adjustment cleared the diff.
  | { type: "overlay_changed"; preset: string; overlay: FocusOverlay | null }
  // A 401 from a registry-origin MCP server marked the market credential
  // stale: the Store re-reads the connection and prompts to reconnect.
  | { type: "registry_credential_stale" }
  // A 401 from the connector MCP server invalidated the connector PAT: the
  // Store re-reads the connection and the card flips to re-paste.
  | { type: "connector_credential_stale" }
  // A 401 from the paper-trading MCP server invalidated the pasted token: the
  // Store re-reads the connection and the card flips to re-paste.
  | { type: "paper_trading_credential_stale" }
  | { type: "user_bindings"; model: BindingModel | null; mcp: McpBindingState[] }
  | { type: "runtime_binding"; model: RuntimeModel | null; mcp: { name: string; enabled: boolean }[] }
  | { type: "runtime_binding_pending"; model: RuntimeModel | null; mcp: { name: string; enabled: boolean }[] };

// A focused role's subscriber adjustment (add-focus-overlay): a preference
// diff over the derived set, never a stored snapshot. Server source of truth
// is the preferences row `focus.overlay.<presetId>`.
export interface FocusOverlay {
  addMcp: string[];
  removeMcp: string[];
  addSkills: string[];
  removeSkills: string[];
}

// A personal model binding (source "personal") or the global fallback. Both
// sources carry the same {id, provider} shape.
export interface BindingModel {
  id?: string;
  provider?: string;
  name?: string;
  updatedAt?: string;
  source: "personal" | "global";
}

export interface RuntimeModel {
  id: string;
  provider: string;
}

// One global MCP server as seen through a user's personal overlay. `personalEnabled`
// is null when the user has expressed no preference; `effectiveEnabled` is what
// the shared runtime patch actually uses.
export interface McpBindingState {
  name: string;
  globalEnabled: boolean;
  personalEnabled: boolean | null;
  effectiveEnabled: boolean;
  locked: boolean;
}

export interface ModelInfo {
  id: string;
  name?: string;
  provider?: string;
  // Selectable thinking levels; absent when the model offers no control.
  reasoningEfforts?: string[];
  // Context window in tokens when the route declares one (chat-usage-display):
  // the denominator of the composer's context meter.
  contextWindow?: number;
}

// Catalog agent (GET /api/catalog / the `agents` WS message). Serialized
// server-side — secrets (apiKey) never reach the client.
export interface AgentInfo {
  id: string;
  type: "agent-local" | "agent-remote";
  name?: string;
  description?: string;  // purpose / capability summary
  icon?: string;         // lucide icon name (resolved via <Icon name={icon} />)
  mode?: "chat" | "link" | "a2a";
  model?: string;
  url?: string;
  tags?: string[];       // categorization badges
  version?: string;      // semver for changelog reference
  featured?: boolean;    // show on Agents dashboard first
  packId?: string;       // pack-sourced entry: its pack (focused role marker)
  packName?: string;     // pack-sourced entry: the pack's display name
  // Cluster metadata (agent-cluster-platform): present when the source pack
  // declares a `cluster` block — drives picker grouping and the "load entire
  // cluster" affordance. Absent on non-cluster entries.
  clusterId?: string;
  clusterName?: string;
  isDefaultAgent?: boolean;
  customPreset?: boolean; // user-defined entry: a custom preset (focused role marker)
  // Role-level resource summary (add-persona-resource-sets): the skill/MCP
  // counts of THIS role's effective set — declared, or the pack's own counts
  // when the role declares none.
  resourceSummary?: { skillCount: number; mcpCount: number; declared: boolean };
}

export interface AppInfo {
  id: string;
  name?: string;
  description?: string;  // purpose / capability summary
  icon?: string;         // lucide icon name
  kind: "link" | "nango-connect" | "external-service";
  url?: string;
  // external-service specific fields:
  features?: string[];   // capability bullets shown in card detail
  embedded?: boolean;    // true = embed in iframe via /external/:appId
  tags?: string[];
  version?: string;
  featured?: boolean;
}

export interface SkillInfo {
  name: string;
  description?: string;
}

// One dsh agent preset (agent mode) from the roster the runtime composes.
// `broken` carries the discovery-reported reason and marks the row unselectable.
export interface PresetInfo {
  id: string;
  name: string;
  description: string;
  trust: "system" | "user";
  broken?: string;
}

// One permission preset (sandbox + approval bundle) from the composed table.
// `name` is the stable table key; `label` is the server-provided display name
// (the raw key for the shipped table — the web bundle localizes those).
export interface PermissionOption {
  name: string;
  label: string;
  description: string;
}

// One whitelisted dsh plugin bundle in the profile roster
// (add-dsh-plugin-supply). `id` is the bundle package name; `enabled` is the
// profile's own selection (the persisted packages are a separate fact —
// disabling never uninstalls). `readOnlyReason` marks management-protected
// bundles the toggle must not touch; `error` names a bundle that failed to
// resolve/patch and therefore cannot be enabled.
export interface PluginBundleInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  installed: boolean;
  optional: boolean;
  removable: boolean;
  readOnlyReason?: string;
  error?: { code?: string; message?: string };
}

// One entry in the agent's plan, mirroring the dsh `todo/write` snapshot shape
// verbatim (no renaming, so raw payloads pass through). The list is replaced
// wholesale on every write — entries carry no stable id by design.
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TodoCounts {
  pending: number;
  inProgress: number;
  completed: number;
}

// ── User questions (add-user-questions) ─────────────────────────────────────
// Mirrors the dsh user-questions seam's wire shape verbatim (camelCase, as
// the runtime emits it) so raw payloads pass through.

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestionItem {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: AskQuestionOption[];
  multiSelect?: boolean;
  /** Presentation intent (e.g. plan-review); rendering it generically is legal. */
  intent?: { kind: "plan-review"; approve: string } | Record<string, unknown>;
}

export interface AskAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

// A prompt waiting behind another session's turn (concurrent-chat-sessions):
// carried by `queued` and by session_loaded.queued, and rendered as a pending
// bubble. `position` is 1-based within the queue; `waitingOn` is null when the
// runtime is busy on a non-web lane.
export interface QueuedTurn {
  text: string;
  position: number;
  waitingOn: { id: string; title: string | null } | null;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  // Preset the session started under (best-effort; null = deployment default).
  agentPreset?: string | null;
  // Runtime workspace the session started in (best-effort; rows written before
  // the capability carry none and render under the sidebar's Ungrouped group).
  workspace?: string | null;
  // Project attribution (add-web-project-container): the web-side top-level
  // container this session was created under, resolved by backing-path
  // backtrace at first mirror. Null/absent on desktop-origin and legacy rows —
  // those render under the read-time 默认项目 group on web, Ungrouped on desktop.
  projectId?: string | null;
  // Live turn state for THIS session (concurrent-chat-sessions): "running" when
  // its turn is open, "queued" when a prompt waits behind another session's
  // turn, null when idle. Server-computed; drives the sidebar indicator.
  turnStatus?: "running" | "queued" | null;
}

// Persisted block structure on assistant messages (chat history): the tool
// evidence trail survives reload. Absent on rows written before this field
// existed — clients fall back to plain content. On USER messages, a leading
// `task_summary` block marks the delegation aggregator's injected summary
// turn (task-authored, not a user bubble).
export type PersistedBlock =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args?: unknown;
      result?: unknown;
      state?: "done" | "error";
    }
  | {
      kind: "task_summary";
      tasks: { id: string; persona: string | null; state: string | null }[];
    };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  blocks?: PersistedBlock[];
  // Row position within the session (polish-web-surfaces): the paging cursor for
  // "load earlier". Absent on older servers and on live (unmirrored) messages.
  seq?: number;
}

// ── Client → server ─────────────────────────────────────────────────────────

export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "list_bindings" }
  | { type: "list_models" }
  | { type: "set_model"; id: string }
  | { type: "set_effort"; effort: string | null }
  // Real stop (live-runtime-control): cancel the run in the child via the
  // bridge's session/cancel. Falls back to a server-side finalize on older
  // children; the client ALSO finalizes its view locally either way.
  // `id` (concurrent-chat-sessions): stop THAT session instead of the one this
  // connection views — a queued prompt's "stop it and run mine instead"
  // targets the session currently blocking the queue. Omitted = the viewed
  // session (the historical shape).
  | { type: "stop_turn"; id?: string }
  // Per-session MCP server gate flip (live-runtime-control): default-closed
  // servers (websearch) the user toggles per conversation.
  | { type: "set_tool_gate"; server: string; enabled: boolean }
  | { type: "list_workspaces" }
  | { type: "set_workspace"; path: string }
  | { type: "list_agents" }
  | { type: "set_agent"; id: string }
  | { type: "list_presets" }
  | { type: "set_preset"; id: string }
  | { type: "list_permissions" }
  // `acknowledge` is required by the server for `danger-full-access` (the
  // client's risk dialog produces it); every other preset ignores it.
  | { type: "set_permission"; name: string; acknowledge?: boolean }
  | { type: "list_plugins" }
  | { type: "set_plugin_enabled"; id: string; enabled: boolean }
  | { type: "list_skills" }
  | { type: "list_sessions" }
  | { type: "new_session" }
  | { type: "switch_session"; id: string; resync?: boolean }
  | { type: "rename_session"; id: string; title: string }
  // Page backwards through a long transcript (polish-web-surfaces): ask for the
  // messages immediately older than `beforeSeq` (the earliest loaded message's
  // seq). Answered with a `session_page`.
  | { type: "load_earlier"; id: string; beforeSeq: number }
  // Scheduled tasks (spec: cron-module). The client-facing job shape mirrors
  // cron.js clientShape().
  | { type: "cron_list" }
  | {
      type: "cron_add";
      cron?: string;
      when?: string;
      prompt: string;
      preset?: string | null;
      tz?: string | null;
      sessionTitle?: string | null;
      // add-cron-automation-parity: the interval form, the server-anchored
      // relative one-shot, the finite-run cap, and the project attribution.
      interval?: { number: number; unit: "minute" | "hour" | "day" | "week" };
      delayMinutes?: number;
      maxRuns?: number;
      projectId?: string | null;
    }
  // In-place edit (add-cron-automation-parity): id, history and paused survive.
  | {
      type: "cron_update";
      jobId: string;
      cron?: string;
      when?: string;
      interval?: { number: number; unit: "minute" | "hour" | "day" | "week" };
      delayMinutes?: number;
      maxRuns?: number;
      prompt?: string;
      tz?: string | null;
      sessionTitle?: string | null;
    }
  | { type: "cron_remove"; jobId: string }
  | { type: "cron_pause"; jobId: string }
  | { type: "cron_resume"; jobId: string }
  | { type: "cron_run"; jobId: string }
  // Answer or cancel the session's pending ask (add-user-questions).
  // First-wins: a late second submission is refused server-side and the
  // client converges on the ask's own tool_end.
  | { type: "answer_question"; askId: string; answers?: AskAnswerItem[]; cancelled?: boolean };

// ── Scheduled tasks ─────────────────────────────────────────────────────────

/** Fleet run header (agent-fleet-runs): one execution instance's projection. */
export interface FleetRunSummary {
  runId: string;
  fleetId: string;
  /** Root source — cron | manual | delegation | event (the root turn's lane). */
  rootSource: string;
  rootMemberId: string;
  startedAt: number;
  endedAt: number | null;
  /** open while anything of the run is in flight; ok | failed | partial closed. */
  status: "open" | "ok" | "failed" | "partial";
  turns: number;
  okCount: number;
  failedCount: number;
  /** Token totals summed from the run's turn rows; null when nothing reported. */
  usage: { input: number | null; output: number | null } | null;
}

export interface CronJobHistoryEntry {
  time: string;
  duration?: number;
  success: boolean | null;
  error?: string;
  /** Execution outcome of this entry ("done" | "failed" | "interrupted"). */
  state?: string;
  /** Token usage the runtime reported on the finish chunk, when available. */
  tokens?: { input?: number; output?: number; total?: number; [k: string]: unknown };
  /** Present on downtime markers: occurrences missed while the cell was down. */
  missed?: number;
  /** Downtime catch-up run (P2): this execution made up a missed occurrence. */
  catchUp?: boolean;
  /** Cluster fan-out: model id each member actually ran under (by member name). */
  models?: Record<string, string>;
}

/** Execution target of a task — "persona" today (the preset that runs it). */
export interface CronJobTarget {
  type: string;
  /** Persona preset id (null = legacy record, runs under the live preset). */
  ref: string | null;
}

export interface CronJob {
  id: string;
  /** Trigger kind — "schedule" (cron/one-shot front-end) or "manual" (delegation). */
  trigger: "schedule" | "manual";
  type: "recurring" | "once" | "manual";
  cron: string | null;
  when: string | null;
  prompt: string;
  /** Execution target. */
  target: CronJobTarget;
  /** Persona preset the job runs under (null = legacy job, runs under the live preset). */
  preset: string | null;
  /** Dedicated session the job's output lands in. */
  sessionId: string | null;
  sessionTitle: string | null;
  /** IANA timezone the cron expression is evaluated in (null = cell-local). */
  tz: string | null;
  status: "scheduled" | "running" | "paused" | "completed" | "expired" | "error" | "manual";
  /** Execution lifecycle of the latest run (null = never ran). */
  state: "queued" | "running" | "done" | "failed" | "interrupted" | null;
  /** Error gist of the latest failed/interrupted execution. */
  error: string | null;
  /** Manual trigger: the session that delegated this task. */
  initiator?: string | null;
  /** Manual trigger: outcome already summarized into the initiator session. */
  aggregated?: boolean;
  // Cluster target (agent-cluster-platform): present when target.type is
  // "cluster" — the label/count the list renders, the policy the run used,
  // and the member subset (null = every cluster agent). Member outputs land
  // in sub-sessions `${sessionId}--<agentId>` beside the bound session.
  clusterId?: string | null;
  clusterName?: string | null;
  agentCount?: number | null;
  executionPolicy?: { allowParallel?: boolean; timeoutMinutes?: number; resultAggregation?: string } | null;
  targetAgents?: string[] | null;
  paused: boolean;
  createdAt: string;
  lastRun: string | null;
  nextRun: string | null;
  missed: number;
  history: CronJobHistoryEntry[];
  // Interval form (add-cron-automation-parity): the every-N rule is the truth
  // (never a coerced cron), `anchor` is when it started (occurrences are
  // anchor + k×step, k ≥ 1). Absent on cron/once records.
  interval?: { number: number; unit: "minute" | "hour" | "day" | "week" } | null;
  anchor?: string | null;
  // Finite-run cap: retire at `maxRuns` completed executions; `runs` counts
  // them (run-now and re-runs included). Absent = unbounded.
  maxRuns?: number | null;
  runs?: number;
  // Project attribution (add-web-project-container): the web project this job
  // was created under, or null/absent for the 默认项目 bucket (legacy + desktop).
  // Opaque to the engine — read surfaces filter on it, same as sourceTag.
  projectId?: string | null;
}
