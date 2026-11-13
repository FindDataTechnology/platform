## MODIFIED Requirements

### Requirement: Server creates and manages a pi agent session
The server SHALL create a single pi `AgentSession` on startup using the pi SDK with in-memory session management and read-only tools. When no chat provider (Volces or LiteLLM) is configured, the server SHALL still create the session and start successfully (chat non-functional, logged) rather than exiting — see "Server degrades gracefully when no chat provider is configured".

#### Scenario: Server starts successfully
- **WHEN** the server starts with a valid API key configured
- **THEN** an `AgentSession` is created with `read`, `bash`, `grep`, `find`, `ls` tools and `SessionManager.inMemory()`

## ADDED Requirements

### Requirement: Server degrades gracefully when no chat provider is configured
The server SHALL start successfully when no chat provider (Volces or LiteLLM) is configured. When `VOLCES_API_KEY` is unset, the Volces provider SHALL NOT be registered. When neither Volces nor LiteLLM is configured, the `extensionFactories` array SHALL be empty, the agent session SHALL still be created (model resolves to the SDK default / `null`), and the server SHALL log a warning that chat is non-functional. The documents RAG SHALL log a warning when it initializes without a Volces key, because indexing/query calls will fail at call time rather than at startup.

#### Scenario: server starts with no chat provider
- **WHEN** the server starts with `VOLCES_API_KEY` unset and LiteLLM not configured
- **THEN** the server SHALL NOT exit
- **AND** SHALL log a warning that no chat provider is configured
- **AND** the agent session SHALL be created with an empty `extensionFactories` array

#### Scenario: documents RAG warns when no Volces key
- **WHEN** the documents store initializes with `VOLCES_API_KEY` unset
- **THEN** the server SHALL log a warning that documents RAG indexing/query calls will fail at call time

### Requirement: No secrets are baked into source
The server SHALL NOT ship a functional API key as a fallback default in source. Provider API keys SHALL be read from environment variables (or, in the packaged app, from `settings.json`); an unset key SHALL resolve to `undefined`, never to a baked-in credential. The `VOLCES_API_KEY` line SHALL use optional chaining (`process.env.VOLCES_API_KEY?.trim()`), and provider registration SHALL be gated on a `volcesEnabled` boolean derived from the resolved key.

#### Scenario: unset key resolves to undefined
- **WHEN** `VOLCES_API_KEY` is unset in the environment
- **THEN** the resolved key SHALL be `undefined`
- **AND** no fallback credential SHALL be substituted from source
- **AND** the Volces provider SHALL NOT be registered

### Requirement: Asynchronous errors are surfaced, not leaked as unhandled rejections
Every asynchronous WebSocket message handler SHALL catch its own promise rejections and emit an `{ type: "error", message }` message to the originating client rather than leaking an unhandled promise rejection. The cron mutation handlers (`cron_remove`, `cron_pause`, `cron_resume`, `cron_run`) SHALL each wrap their async work in `try/catch`, mirroring `cron_add`. The connect-time `workdirStore.getWorkdir()` promise SHALL have a rejection handler that logs. The `shutdown()` path SHALL wrap the `closeMcpClients` await in `try/catch` so a rejection does not prevent `process.exit(0)`. The reverse-proxy response reads in `createWebProxy` and `proxyLitellmUi` SHALL wrap `await upstreamRes.arrayBuffer()` in `try/catch` and return HTTP 502 on failure.

#### Scenario: a cron handler error is surfaced to the client
- **WHEN** a `cron_remove`, `cron_pause`, `cron_resume`, or `cron_run` handler throws
- **THEN** the server SHALL emit `{ type: "error", message }` to the originating WebSocket client
- **AND** SHALL NOT leak an unhandled promise rejection

#### Scenario: shutdown completes despite closeMcpClients failure
- **WHEN** `closeMcpClients` rejects during shutdown
- **THEN** the server SHALL log the error and SHALL still exit

#### Scenario: proxy response-read failure returns 502
- **WHEN** `await upstreamRes.arrayBuffer()` rejects in `createWebProxy` or `proxyLitellmUi`
- **THEN** the server SHALL respond with HTTP 502 and a message describing the read failure
