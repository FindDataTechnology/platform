## ADDED Requirements

### Requirement: Server creates and manages a pi agent session
The server SHALL create a single pi `AgentSession` on startup using the pi SDK with in-memory session management and read-only tools.

#### Scenario: Server starts successfully
- **WHEN** the server starts with a valid API key configured
- **THEN** an `AgentSession` is created with `read`, `bash`, `grep`, `find`, `ls` tools and `SessionManager.inMemory()`

#### Scenario: Server fails without API key
- **WHEN** the server starts without a configured API key
- **THEN** the server SHALL log an error and exit with a non-zero code

### Requirement: Server accepts user prompts via WebSocket
The server SHALL accept JSON messages of type `prompt` over WebSocket and forward them to the pi agent session.

#### Scenario: User sends a prompt
- **WHEN** a WebSocket client sends `{ "type": "prompt", "text": "List files" }`
- **THEN** the server calls `session.prompt("List files")` and streams the response back

#### Scenario: User sends prompt while agent is streaming
- **WHEN** a WebSocket client sends a prompt while the agent is already processing
- **THEN** the server SHALL queue the prompt using `steer` behavior

### Requirement: Server streams agent text responses
The server SHALL subscribe to pi session events and forward `text_delta` events as WebSocket messages to the client.

#### Scenario: Agent generates text
- **WHEN** the agent generates a text response
- **THEN** the server SHALL send `{ "type": "text", "delta": "<partial text>" }` messages for each delta

#### Scenario: Agent finishes responding
- **WHEN** the agent completes its response
- **THEN** the server SHALL send `{ "type": "done" }`

### Requirement: Server streams tool execution events
The server SHALL forward `tool_execution_start` and `tool_execution_end` events to the client.

#### Scenario: Agent runs a tool
- **WHEN** the agent starts executing a tool
- **THEN** the server SHALL send `{ "type": "tool_start", "name": "<tool name>" }`
- **AND** when the tool finishes, send `{ "type": "tool_end", "name": "<tool name>", "isError": <boolean> }`

### Requirement: Server serves static frontend files
The server SHALL serve the `public/` directory as static files at the root path.

#### Scenario: Browser requests the page
- **WHEN** a browser navigates to `http://localhost:3000`
- **THEN** the server SHALL return `public/index.html`