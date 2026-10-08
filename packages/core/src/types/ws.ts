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

export type ServerMessage =
  | { type: "user"; text: string; budgetLeft?: number; taskSummary?: boolean; sessionId?: string }
  | ({ type: "agent_start" } & { sessionId?: string })
  | ({ type: "text"; delta: string } & { sessionId?: string })
  | ({ type: "thinking"; delta: string } & { sessionId?: string })
  | ({ type: "tool_start"; toolCallId: string; name: string; args: unknown } & { sessionId?: string })
  | ({ type: "tool_update"; toolCallId: string; name: string; partialResult: unknown } & { sessionId?: string })
  | ({ type: "tool_end"; toolCallId: string; name?: string; result: unknown; isError?: boolean } & { sessionId?: string })
  | ({ type: "skill_use"; name: string; args?: string } & { sessionId?: string })
  | ({ type: "command_use"; name: string; args?: string; message?: string } & { sessionId?: string })
  | ({ type: "done" } & { sessionId?: string })
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
  | { type: "error"; message: string; code?: string }
  | { type: "current_model"; id: string | null; effort?: string | null }
  | { type: "models"; models: ModelInfo[] }
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
  | { type: "session_changed"; id: string }
  | {
      type: "session_loaded";
      id: string;
      title?: string;
      messages: ChatMessage[];
      // Reconnect resync (add-reconnect-resync): a turn is in flight for this
      // session. With `turnEvents` the client rebuilds the open turn by
      // folding the server's replay log; without it (buffer miss — overflow
      // or process restart) it keeps its local partial and continues live.
      // Absent on older servers — the transcript replace then applies as
      // before.
      running?: boolean;
      turnEvents?: TurnEvent[];
    }
  | { type: "session_renamed"; id: string; title: string }
  | { type: "cron_jobs"; jobs: CronJob[] }
  | { type: "cron_status"; job: CronJob }
  | { type: "cron_removed"; id: string }
  | { type: "cron_fired"; id: string; prompt: string; state?: string }
  | { type: "cron_completed"; id: string; success?: boolean; state?: string; error?: string; completedAt?: string }
  | { type: "cron_added"; job: CronJob }
  | { type: "cron_paused"; jobId: string; success: boolean }
  | { type: "cron_resumed"; jobId: string; success: boolean }
  | { type: "cron_run_started"; jobId: string; success: boolean; state?: string; already?: boolean; message?: string }
  // Rejected cron action (e.g. invalid cron expression in cron_add) — scoped
  // to the action so it can render in the owning view instead of a toast.
  | { type: "cron_error"; action: string; message: string }
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
}

// ── Client → server ─────────────────────────────────────────────────────────

export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "list_bindings" }
  | { type: "list_models" }
  | { type: "set_model"; id: string }
  | { type: "set_effort"; effort: string | null }
  | { type: "list_workspaces" }
  | { type: "set_workspace"; path: string }
  | { type: "list_agents" }
  | { type: "set_agent"; id: string }
  | { type: "list_presets" }
  | { type: "set_preset"; id: string }
  | { type: "list_permissions" }
  | { type: "set_permission"; name: string }
  | { type: "list_skills" }
  | { type: "list_sessions" }
  | { type: "new_session" }
  | { type: "switch_session"; id: string; resync?: boolean }
  | { type: "rename_session"; id: string; title: string }
  // Scheduled tasks (spec: cron-module). The client-facing job shape mirrors
  // cron.js clientShape().
  | { type: "cron_list" }
  | { type: "cron_add"; cron?: string; when?: string; prompt: string; preset?: string | null; tz?: string | null; sessionTitle?: string | null }
  | { type: "cron_remove"; jobId: string }
  | { type: "cron_pause"; jobId: string }
  | { type: "cron_resume"; jobId: string }
  | { type: "cron_run"; jobId: string }
  // Answer or cancel the session's pending ask (add-user-questions).
  // First-wins: a late second submission is refused server-side and the
  // client converges on the ask's own tool_end.
  | { type: "answer_question"; askId: string; answers?: AskAnswerItem[]; cancelled?: boolean };

// ── Scheduled tasks ─────────────────────────────────────────────────────────

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
  paused: boolean;
  createdAt: string;
  lastRun: string | null;
  nextRun: string | null;
  missed: number;
  history: CronJobHistoryEntry[];
}
