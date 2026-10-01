// WebSocket message types.
//
// Source of truth for what the Node backend broadcasts and accepts. Mirrors
// server.js. When server.js grows a new type, add it here — the React store's
// exhaustive switch will fail to compile until the case is handled.

// ── Server → client ─────────────────────────────────────────────────────────

export type ServerMessage =
  | { type: "user"; text: string; budgetLeft?: number; taskSummary?: boolean }
  | { type: "agent_start" }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; name: string; partialResult: unknown }
  | { type: "tool_end"; toolCallId: string; name: string; result: unknown; isError?: boolean }
  | { type: "skill_use"; name: string; args?: string }
  | { type: "command_use"; name: string; args?: string; message?: string }
  | { type: "done" }
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
  | { type: "session_loaded"; id: string; title?: string; messages: ChatMessage[] }
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
  | { type: "switch_session"; id: string }
  | { type: "rename_session"; id: string; title: string }
  // Scheduled tasks (spec: cron-module). The client-facing job shape mirrors
  // cron.js clientShape().
  | { type: "cron_list" }
  | { type: "cron_add"; cron?: string; when?: string; prompt: string; preset?: string | null; tz?: string | null; sessionTitle?: string | null }
  | { type: "cron_remove"; jobId: string }
  | { type: "cron_pause"; jobId: string }
  | { type: "cron_resume"; jobId: string }
  | { type: "cron_run"; jobId: string };

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
