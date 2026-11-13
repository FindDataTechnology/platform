## MODIFIED Requirements

### Requirement: Server creates and manages a dsh agent session
The server SHALL create a single agent session on startup by spawning the dsh runtime as a subprocess and establishing a JSON-RPC session over stdio (see `dsh-runtime-bridge`). The session SHALL be in-memory and equipped with the dsh-profile tools (`dsh-tool-bash`, `dsh-tool-fs`, `dsh-mcp-client`). When no chat provider (Volces or LiteLLM) is configured, the server SHALL still spawn the runtime and start successfully (chat non-functional, logged) rather than exiting — see "Server degrades gracefully when no chat provider is configured".

#### Scenario: Server starts successfully
- **WHEN** the server starts with a valid API key configured and the dsh binary discoverable
- **THEN** the dsh runtime SHALL be spawned with a profile composing bash, fs, grep, find, ls, and MCP tools and an in-memory session

#### Scenario: User sends a prompt
- **WHEN** a WebSocket client sends `{ "type": "prompt", "text": "List files" }`
- **THEN** the server forwards the prompt to the dsh runtime via JSON-RPC and streams the translated response back

#### Scenario: User sends prompt while agent is streaming
- **WHEN** a WebSocket client sends a prompt while the agent is already processing
- **THEN** the server SHALL queue the prompt using `steer` behavior or reject it, preserving the existing streaming guard

### Requirement: Server streams agent text responses
The server SHALL subscribe to dsh session notifications and translate assistant text-delta notifications into `text_delta`-equivalent WebSocket messages to the client.

#### Scenario: Agent generates text
- **WHEN** the dsh runtime emits an assistant text-delta notification
- **THEN** the server SHALL broadcast `{ "type": "text", "delta": "<partial text>" }` for each delta

#### Scenario: Agent finishes responding
- **WHEN** the dsh runtime signals turn completion
- **THEN** the server SHALL broadcast `{ "type": "done" }`

### Requirement: Server streams tool execution events
The server SHALL translate dsh `tool/*` lifecycle notifications into `tool_execution_start`/`tool_execution_end`-equivalent WebSocket events.

#### Scenario: Agent runs a tool
- **WHEN** the dsh runtime emits a tool-start notification
- **THEN** the server SHALL broadcast `{ "type": "tool_start", "name": "<tool name>" }`
- **AND** on the tool-end notification, broadcast `{ "type": "tool_end", "name": "<tool name>", "isError": <boolean> }`

### Requirement: Server serves static frontend files
The server SHALL serve the `web/dist/` directory (SPA, built by Vite) as static files at the root path with a SPA fallback for deep links.

#### Scenario: Browser requests the page
- **WHEN** a browser navigates to `http://localhost:3000`
- **THEN** the server SHALL return the React SPA entry `web/dist/index.html`

### Requirement: Server degrades gracefully when no chat provider is configured
The server SHALL start successfully when no chat provider (Volces or LiteLLM) is configured. When `VOLCES_API_KEY` is unset, the Volces llm adapter SHALL NOT be loaded into the dsh profile. When neither Volces nor LiteLLM is configured, the dsh profile SHALL load no llm adapters, the runtime SHALL still be spawned, and the server SHALL log a warning that chat is non-functional. The documents RAG SHALL log a warning when it initializes without a Volces key.

#### Scenario: server starts with no chat provider
- **WHEN** the server starts with `VOLCES_API_KEY` unset and LiteLLM not configured
- **THEN** the server SHALL NOT exit
- **AND** SHALL log a warning that no chat provider is configured
- **AND** the dsh runtime SHALL be spawned with no llm adapter in the profile

#### Scenario: documents RAG warns when no Volces key
- **WHEN** the documents store initializes with `VOLCES_API_KEY` unset
- **THEN** the documents module SHALL log a warning that indexing/query calls will fail at call time

## RENAMED Requirements

- FROM: `### Requirement: Server creates and manages a pi agent session`
- TO: `### Requirement: Server creates and manages a dsh agent session`

## REMOVED Requirements

### Requirement: Server accepts user prompts via WebSocket
