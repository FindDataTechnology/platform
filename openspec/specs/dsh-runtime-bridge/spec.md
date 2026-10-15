# dsh-runtime-bridge Specification

## Purpose
TBD - created by archiving change migrate-pi-to-dsh. Update Purpose after archive.
## Requirements
### Requirement: Server spawns the dsh runtime as a subprocess communicating over JSON-RPC stdio

The server SHALL spawn the DeepSeek Harness (dsh) runtime as a child process (`dsh` CLI or a composed entrypoint) with stdio pipes, and SHALL communicate with it using newline-delimited JSON-RPC 2.0. The server SHALL own the child process lifecycle: spawn on startup, health-check, restart-with-backoff on unexpected exit, and terminate on shutdown. The server SHALL remain buildless plain JavaScript ESM — the dsh runtime is the only TypeScript process, isolated in the subprocess. When the dsh binary is absent, the server SHALL log a warning and start without chat capability (degraded), mirroring the existing "no chat provider" graceful-degradation contract.

#### Scenario: dsh runtime spawned at startup
- **WHEN** the server starts with the dsh binary discoverable
- **THEN** the server SHALL spawn the dsh child process with stdio pipes and send a JSON-RPC `initialize` request
- **AND** SHALL await the `initialize` result before accepting prompts

#### Scenario: dsh binary absent degrades gracefully
- **WHEN** the server starts and the dsh binary is not on PATH or the configured path
- **THEN** the server SHALL log a warning that chat is non-functional and continue serving static + REST endpoints
- **AND** SHALL NOT crash

#### Scenario: unexpected child exit triggers restart
- **WHEN** the dsh child process exits unexpectedly
- **THEN** the server SHALL restart it with exponential backoff up to a max-retries ceiling
- **AND** SHALL broadcast an `error` event to clients if a prompt was in flight

### Requirement: Bridge translates JSON-RPC notifications to existing WebSocket events

The server SHALL subscribe to dsh JSON-RPC notifications (`session.event`, `session.status`, `subagent.*`) and translate each into the existing WebSocket event vocabulary so the frontend contract is unchanged. The mapping SHALL cover: dsh `assistant/text` deltas → WS `text`; dsh `tool/*` lifecycle → WS `tool_start`/`tool_update`/`tool_end`; dsh turn completion → WS `done`; dsh errors → WS `error`. The translation layer SHALL be the single seam that isolates the dsh protocol from the frontend.

#### Scenario: assistant text delta translated
- **WHEN** the dsh runtime sends a `session.event` notification carrying an assistant text delta
- **THEN** the server SHALL broadcast `{ "type": "text", "delta": "<delta>" }` to all WS clients

#### Scenario: tool lifecycle translated
- **WHEN** the dsh runtime sends tool execution start/update/end notifications
- **THEN** the server SHALL broadcast the corresponding `tool_start`/`tool_update`/`tool_end` WS events with matching `name`, `args`, `result`, and `isError` fields

#### Scenario: turn completion translated
- **WHEN** the dsh runtime signals turn completion via `session.status`
- **THEN** the server SHALL broadcast `{ "type": "done" }` exactly once per turn

### Requirement: Server forwards prompts to the dsh runtime via JSON-RPC request

The server SHALL forward each accepted WebSocket `prompt` message to the dsh runtime as a JSON-RPC `session.prompt` request (or the dsh-equivalent method), correlating the response with the originating turn. The server SHALL queue or reject prompts while a turn is in flight, preserving the existing streaming-guard behavior.

#### Scenario: prompt forwarded to dsh
- **WHEN** the server receives a WS `prompt` message and no turn is in flight
- **THEN** the server SHALL send a JSON-RPC prompt request to the dsh child and set the streaming guard

#### Scenario: prompt during streaming is rejected
- **WHEN** the server receives a WS `prompt` message while a turn is streaming
- **THEN** the server SHALL reject it with an error, mirroring the existing streaming guard

### Requirement: dsh runtime is configured via a profile that composes core plugins

The server SHALL pass the dsh runtime a profile/bundle configuration (or CLI flags) that composes: `core/session`, `core/agent-loop`, `core/tools`, `dsh-tool-bash`, `dsh-tool-fs` (read/write/edit/grep), `dsh-mcp-client`, and the platform's Volces llm adapter. The profile SHALL be the single source of which plugins the runtime loads; the server SHALL NOT duplicate tool or MCP wiring in JavaScript.

#### Scenario: profile composes built-in tools
- **WHEN** the dsh runtime starts with the platform profile
- **THEN** bash, fs read/write/edit/grep, and MCP tools SHALL be available to the agent via dsh plugins, with no custom tool-bridge code in the server

#### Scenario: profile composes MCP client
- **WHEN** the profile includes `dsh-mcp-client` and a server config is provided
- **THEN** MCP tools SHALL be registered with `mcp__<serverName>__<toolName>` names by the dsh plugin, not by server-side JavaScript

### Requirement: Bridge restart accepts a new working directory

The dsh bridge's `restart()` SHALL accept an optional `cwd` alongside the existing `provider` and `model` overrides. When supplied, the bridge SHALL use it as the working directory for both the spawned child process and the `initialize` handshake, and SHALL retain it for subsequent restarts until overridden again. When omitted, the bridge SHALL reuse the current working directory.

#### Scenario: restart with a new cwd

- **WHEN** `restart({ cwd: "/Users/me/proj" })` is called
- **THEN** the bridge SHALL terminate the existing dsh child
- **AND** SHALL spawn a replacement whose process cwd and `initialize` params both carry `/Users/me/proj`

#### Scenario: restart without cwd preserves the current one

- **WHEN** `restart({ model: "deepseek-v4-flash" })` is called after a previous restart set the cwd to `/Users/me/proj`
- **THEN** the replacement child SHALL be spawned with cwd `/Users/me/proj`

#### Scenario: cwd persists across an unexpected-exit restart

- **WHEN** the dsh child exits unexpectedly after the cwd was changed
- **THEN** the automatic backoff restart SHALL spawn the replacement with the most recently set cwd, not the original startup directory

### Requirement: The generated dsh profile composes the agent-preset roster and bridge

On profile generation, the server SHALL write a patch overlay inserting (1)
the `@deepseek-ai/dsh-agent-presets` roster plugin configured with the shipped
preset root resolved from the installed `@deepseek-ai/dsh` package and
`default: standard`, and (2) a local bridge plugin that subclasses
`HarnessSdkJsonRpcServer` — row id `sdk-jsonrpc-server`, replacing the stock
row — so both load into the spawned dsh child. The template's `package.json`
SHALL pin `@deepseek-ai/dsh-agent-presets` at the same release-candidate
version as the other dsh peer dependencies. When the shipped preset root
cannot be resolved, the generator SHALL skip those rows with a warning
(graceful degradation: chat still works, preset picker stays empty) rather
than fail profile generation.

#### Scenario: profile contains the roster + bridge rows
- **WHEN** the server generates the platform dsh profile at boot
- **THEN** the generated patch SHALL contain an `agent-presets` row and a
  `sdk-jsonrpc-server` row whose plugin resolves to the local bridge file
- **AND** the bridge file exists in the generated profile directory

#### Scenario: shipped root unresolvable
- **WHEN** the `@deepseek-ai/dsh` package's `config/agent-presets` directory
  cannot be resolved at generation time
- **THEN** the server SHALL log a warning and boot normally with an empty
  roster

### Requirement: The bridge mounts the selected preset before session publication

The bridge SDK server SHALL accept an `agentPreset` parameter on `initialize`
and SHALL, when lazily creating OR resuming a session's agent, call
`agentPresets.mount(agentCtx, id)` from the unpublished-agent `setup` hook so
a broken or unknown preset fails session creation or resume before the agent
is published. It SHALL add a `presets/list` JSON-RPC method returning the roster
service's rows. When no preset is named it SHALL leave session creation to the
roster default configured on the plugin.

#### Scenario: selected mode is mounted on the next session
- **WHEN** the server initializes the bridge with `agentPreset: "minimal"` and
  the first prompt lazily creates the session
- **THEN** the created agent SHALL be composed under the `minimal` standing
  mount before its first prompt is admitted

#### Scenario: broken preset fails session creation
- **WHEN** `initialize` names a preset the roster marks broken
- **THEN** the first prompt SHALL surface a session-creation error naming the
  preset and no half-composed agent SHALL remain published

#### Scenario: roster query
- **WHEN** a `presets/list` JSON-RPC request arrives
- **THEN** the bridge SHALL answer with every roster row (id, display name,
  description, trust, broken state) or an empty list when no roster is
  composed

#### Scenario: resumed sessions carry the preset mount too

- **WHEN** the bridge resumes a persisted session and a preset is selected
- **THEN** the resumed agent SHALL be composed under that preset's standing
  mount via the same pre-publication setup hook as a created session

### Requirement: Session continuity across dsh child restarts

The bridge SDK server SHALL keep a session usable after the dsh child process
restarts (config-change restart or crash auto-restart): when a prompt targets a
session id whose persisted log exists, the bridge SHALL resume that session
from its stored log instead of creating a fresh live session under the same id.
The decision SHALL be made before any session object is created; the platform
MUST NOT rely on catching a creation error, because creation with an empty
seed can succeed and only fail later at the first persisted append.

#### Scenario: prompt after a model-switch restart continues the session

- **WHEN** a turn has run on session `S` (its log is persisted), the child is
  restarted by a model or workspace switch, and the user prompts `S` again
- **THEN** the bridge SHALL load `S`'s persisted log, and the turn SHALL NOT
  fail with an id-collision error

#### Scenario: context survives the restart

- **WHEN** a turn tells the agent a fact, the child restarts, and the next
  prompt on the same session asks for that fact
- **THEN** the answer SHALL reflect the pre-restart conversation

#### Scenario: switching to an older conversation after a restart

- **WHEN** the child has restarted and a client switches to a previously
  persisted session and prompts it
- **THEN** the bridge SHALL resume that session's log and admit the turn

#### Scenario: torn final turn does not block resume

- **WHEN** the child is killed mid-turn, leaving the session log without a
  closing turn event, and the restarted child resumes that session
- **THEN** resume SHALL succeed and the next turn SHALL run; the incomplete
  tail SHALL not corrupt the session

#### Scenario: unpersisted session ids still create fresh

- **WHEN** a prompt targets a session id with no persisted log (a brand-new
  conversation)
- **THEN** the bridge SHALL create the session exactly as before, with no
  resume attempt

#### Scenario: resume failure is surfaced, never silent

- **WHEN** the persisted log cannot be resumed (unreadable or incompatible)
- **THEN** the prompting client SHALL receive an error message naming the
  session, and the turn SHALL NOT end with empty output and no explanation

### Requirement: Restart carries the selected preset

`dshBridge.restart` SHALL accept an `agentPreset` option that is sent to the
fresh child's `initialize` handshake, alongside the existing provider/model
and workspace arguments.

#### Scenario: mode switch restarts with preset
- **WHEN** the server restarts the bridge with `{ agentPreset: "code" }`
- **THEN** the spawned child SHALL be initialized with
  `agentPreset: "code"` and subsequent new sessions run PTC mode

### Requirement: Per-session preset selection parks until the session exists

The platform bridge SHALL accept `preset/set {sessionId, presetId}` as a live JSON-RPC method: the selection is PARKED for the named session id and applies when that session is (lazily) created — the creation-time mount resolves the parked preset first, then the initialize-time `agentPreset`, then the registry default — and the session header (`meta.agentPreset`) SHALL name the preset actually mounted. `preset/set` on a session that already has a live agent SHALL be refused with an explicit structured error stating that persona is creation-time composition (start a new session), never silently ignored. A parked preset id that cannot be resolved at creation SHALL fail session creation loudly before any agent is published (the factory rolls the whole creation back) — the same contract the initialize-time preset already follows. `platform/capabilities` SHALL report `preset/set` so hosts can gate pod-mode serving on it and degrade to solo against an older child.

#### Scenario: A parked preset applies at creation

- **WHEN** the host calls `preset/set {sessionId: "s1", presetId: "packs-demo-writer"}` before the first prompt of "s1"
- **THEN** "s1"'s agent composes with that preset's persona, and the session header's `meta.agentPreset` names it

#### Scenario: A live session's preset is refused explicitly

- **WHEN** the host calls `preset/set` for a session that already has a live agent
- **THEN** the call fails with a structured error naming the creation-time-composition rule, and the session keeps its mounted preset

#### Scenario: An unknown preset fails session creation loudly

- **WHEN** a parked (or initialize-time) preset id is not in the roster when the session is created
- **THEN** session creation fails before the agent is published, no half-composed agent serves, and no residue leaks into later sessions

#### Scenario: Capabilities report the method

- **WHEN** the host probes `platform/capabilities`
- **THEN** the reported method set includes `preset/set` alongside `model/set` and `session/cancel`

### Requirement: The bridge exposes the permission preset roster and live switch
The bridge plugin (the subclassed SDK JSON-RPC server) SHALL serve
`permissions/list` returning every switchable preset with its client label
and description plus the session's effective preset, and `permissions/set`
applying a preset to the live session through the runtime's permission
service. An unknown preset name SHALL fail the RPC call.

#### Scenario: roster lists the composed presets
- **WHEN** the platform requests `permissions/list` after the dsh child is
  ready
- **THEN** the bridge returns the presets from the runtime's permission
  service with display metadata and the current selection

#### Scenario: live switch takes effect without respawning the child
- **WHEN** the platform requests `permissions/set` with a known preset name
- **THEN** the bridge applies the switch to the current session and the same
  dsh child keeps running

### Requirement: Permission state changes flow to the platform as session events
The dsh session events recording permission switches SHALL be translated by
the bridge's event pump into WebSocket broadcasts, so the platform's view of
the current preset stays factual across every origin of change.

#### Scenario: switch event becomes a WebSocket broadcast
- **WHEN** a permission preset switch is recorded on the session
- **THEN** connected web clients receive the updated current preset

### Requirement: The runtime registers a platform user-questions provider

The composed dsh runtime SHALL register a user-questions provider so that `ask_user_question` tool calls in platform sessions are delivered to the platform host instead of failing with a missing-provider error. A delivered ask SHALL carry the asking session's identity and the full question batch, and the tool call SHALL remain pending until the platform returns an answer or a cancellation.

#### Scenario: ask reaches the platform

- **WHEN** the agent calls `ask_user_question` in a platform session
- **THEN** the platform host receives the question batch and the session identity, and no missing-provider error is produced

#### Scenario: delegated callers never surface a card

- **WHEN** an agent owned by another live agent attempts `ask_user_question`
- **THEN** the runtime rejects the call with the delegated-caller error and no question is delivered to any surface

### Requirement: Pending asks resolve over the host-to-runtime request channel

The platform SHALL deliver answers and cancellations for pending asks to the runtime over the existing host-to-runtime request channel. An answer SHALL resolve the pending tool call with the structured answer batch; a cancellation SHALL resolve it with a cancelled error the model can observe and recover from.

#### Scenario: answer resolves the tool call

- **WHEN** the platform delivers an answer for a pending ask
- **THEN** the tool call completes with that answer and the turn continues with the answer as the tool result

#### Scenario: cancellation surfaces as a recoverable error

- **WHEN** the platform delivers a cancellation for a pending ask
- **THEN** the tool call completes with a cancelled error and the model continues the turn

### Requirement: Runtime lifecycle releases pending asks safely

WHEN the runtime exits, restarts, or its turn aborts while an ask is pending, the ask SHALL be released — never left permanently wedged — and connected surfaces SHALL observe the failure through the tool call's error outcome.

#### Scenario: restart mid-ask

- **WHEN** the runtime restarts while a question card is pending on a surface
- **THEN** the pending ask is released and the card resolves to an error state instead of waiting forever

### Requirement: The bridge's live-control surface is dsh-specific depth

The platform bridge's live-control methods (`preset/set`, `model/set`, `tools/set`, `session/cancel`, `platform/stream` forwarding) and the pod-serving composition they enable SHALL be understood as dsh-specific depth, not part of the harness-adapter contract (openspec: harness-adapter). A host driving a non-dsh harness SHALL detect the surface's absence through the adapter's capability report and degrade to that harness's native equivalents (for ACP: model selection through `session/set_config_option`, cancellation through `session/cancel`, streaming through the ACP wire) — never by assuming the platform bridge exists, and never by silently skipping a control the caller requested.

#### Scenario: A control the harness lacks is reported, not assumed

- **WHEN** the host requests a live persona switch on an ACP-harness agent
- **THEN** the adapter's capability report (not the bridge) is the source of truth: the request fails structurally naming the unsupported capability, and no bridge method is probed

#### Scenario: The dsh path is unchanged

- **WHEN** a dsh-harness agent is served after this change
- **THEN** the bridge's method set, parking semantics, stream forwarding, and pod serving behave exactly as before — the interface refactor is invisible to the dsh path
