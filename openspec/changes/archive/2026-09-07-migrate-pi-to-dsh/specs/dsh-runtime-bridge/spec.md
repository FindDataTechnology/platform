## ADDED Requirements

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

The server SHALL pass the dsh runtime a profile/bundle configuration (or CLI flags) that composes: `core/session`, `core/agent-loop`, `core/tools`, `dsh-tool-bash`, `dsh-tool-fs` (read/write/edit/grep), `dsh-mcp-client`, and the platform's Volces/LiteLLM llm adapter. The profile SHALL be the single source of which plugins the runtime loads; the server SHALL NOT duplicate tool or MCP wiring in JavaScript.

#### Scenario: profile composes built-in tools
- **WHEN** the dsh runtime starts with the platform profile
- **THEN** bash, fs read/write/edit/grep, and MCP tools SHALL be available to the agent via dsh plugins, with no custom tool-bridge code in the server

#### Scenario: profile composes MCP client
- **WHEN** the profile includes `dsh-mcp-client` and a server config is provided
- **THEN** MCP tools SHALL be registered with `mcp__<serverName>__<toolName>` names by the dsh plugin, not by server-side JavaScript
