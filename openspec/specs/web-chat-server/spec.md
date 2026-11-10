# web-chat-server Specification

## Purpose
The Node backend that hosts the web chat: it spawns and owns the dsh agent session, accepts `prompt` messages over WebSocket and hands them to the turn dispatcher, streams assistant text and tool lifecycle events back to clients, serves the Vite-built SPA with a deep-link fallback, and starts listening within about a second, before background initialization completes. It must boot without a chat provider, never ship a baked-in API key, surface every async handler error as a client `error` instead of an unhandled rejection, and keep its HTTP and WebSocket contract stable across internal decomposition. It also synchronizes shared runtime-profile changes, holds one pending ask per session with ownership-checked first-wins answers (bot-session asks never reach the web transcript), and buffers in-flight turn events so `session_loaded` can replay a running turn to a client that switches in or reconnects.

## Requirements

### Requirement: Server creates and manages a dsh agent session

The server SHALL create a single agent session on startup by spawning the dsh runtime as a subprocess and establishing a JSON-RPC session over stdio (see `dsh-runtime-bridge`). The session SHALL be in-memory and equipped with the dsh-profile tools (`dsh-tool-bash`, `dsh-tool-fs`, `dsh-mcp-client`). When no chat provider is configured, the server SHALL still spawn the runtime and start successfully (chat non-functional, logged) rather than exiting — see "Server degrades gracefully when no chat provider is configured". The single shared session SHALL have one effective runtime profile composed from global configuration and, when applied, an authenticated user's personal model and MCP availability bindings. The profile coordinator SHALL not preempt an in-flight response; it SHALL retain a different requested profile as pending until the runtime is idle.

#### Scenario: Server starts successfully
- **WHEN** the server starts with a valid API key configured and the dsh binary discoverable
- **THEN** the dsh runtime SHALL be spawned with a profile composing bash, fs, grep, find, ls, and MCP tools and an in-memory session

#### Scenario: User sends a prompt
- **WHEN** a WebSocket client sends `{ "type": "prompt", "text": "List files" }`
- **THEN** the server forwards the prompt to the dsh runtime via JSON-RPC and streams the translated response back

#### Scenario: User sends prompt while agent is streaming
- **WHEN** a WebSocket client sends a prompt while the agent is already processing
- **THEN** the server SHALL queue the prompt using `steer` behavior or reject it, preserving the existing streaming guard

#### Scenario: Personal profile waits for an in-flight response
- **WHEN** an authenticated user requests a different effective runtime profile while a prompt is streaming
- **THEN** the response continues to completion
- **AND** the requested profile is retained as pending
- **AND** the profile is applied only after the runtime becomes idle

### Requirement: Server accepts user prompts via WebSocket
The server SHALL accept JSON messages of type `prompt` over WebSocket and hand them to the turn dispatcher (`turn-dispatch`), which forwards them to the dsh agent session. The server SHALL track, per connection, the session that connection's client is viewing, and a prompt received from a connection SHALL be recorded into that connection's viewed session (`session-ownership`). The shared runtime executes one web turn at a time; this SHALL be enforced by the dispatcher (a prompt for another session while a turn is open is queued, never dispatched alongside it), not by the client's navigation pattern. The prompt SHALL carry its target session id explicitly through dispatch so a session switch between acceptance and dispatch cannot re-attribute it.

#### Scenario: User sends a prompt
- **WHEN** a WebSocket client sends `{ "type": "prompt", "text": "List files" }` and the runtime is idle
- **THEN** the server dispatches the prompt into the session that client is viewing and streams the response back
- **AND** the user message is recorded into that session

#### Scenario: User sends a prompt into the same session while it is streaming
- **WHEN** a WebSocket client sends a prompt for the session whose turn is already in flight
- **THEN** the server SHALL reject it with the in-flight error (`The agent is still responding`)

#### Scenario: User sends prompt while agent is streaming
- **WHEN** a WebSocket client views session B and sends a prompt while session A's turn is in flight
- **THEN** the server SHALL queue B's prompt and report `queued` to B's viewers (`turn-dispatch`)
- **AND** SHALL NOT dispatch it into the runtime until A's turn closes

#### Scenario: Two users viewing different sessions
- **WHEN** two connections view different sessions and the second sends a prompt
- **THEN** that prompt's user message and reply are recorded into the second connection's viewed session
- **AND** the first connection's viewed session transcript is unchanged

#### Scenario: Attribution survives a switch mid-dispatch
- **WHEN** a prompt for session A is accepted and another connection switches the live agent to session B before A's prompt reaches the runtime
- **THEN** A's prompt SHALL still execute in and be recorded into session A

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
The server SHALL serve the `web/dist/` directory (SPA, built by Vite) as static files at the root path with a SPA fallback for deep links, with HTTP compression enabled for compressible static assets.

#### Scenario: Browser requests the page
- **WHEN** a browser navigates to `http://localhost:3000`
- **THEN** the server SHALL return the React SPA entry `web/dist/index.html`

#### Scenario: compressible asset is requested
- **WHEN** a client requests a large text-based asset (e.g. the app entry chunk) with `Accept-Encoding` allowing gzip/br
- **THEN** the server SHALL return the asset content-compressed rather than uncompressed

### Requirement: Server degrades gracefully when no chat provider is configured
The server SHALL start successfully when no chat provider is configured. When `VOLCES_API_KEY` is unset, the Volces llm adapter SHALL NOT be loaded into the dsh profile, the dsh profile SHALL load no llm adapters, the runtime SHALL still be spawned, and the server SHALL log a warning that chat is non-functional. The documents RAG SHALL log a warning when it initializes without a Volces key.

#### Scenario: server starts with no chat provider
- **WHEN** the server starts with `VOLCES_API_KEY` unset
- **THEN** the server SHALL NOT exit
- **AND** SHALL log a warning that no chat provider is configured
- **AND** the dsh runtime SHALL be spawned with no llm adapter in the profile

#### Scenario: documents RAG warns when no Volces key
- **WHEN** the documents store initializes with `VOLCES_API_KEY` unset
- **THEN** the documents module SHALL log a warning that indexing/query calls will fail at call time

### Requirement: No secrets are baked into source
The server SHALL NOT ship a functional API key as a fallback default in source. Provider API keys SHALL be read from environment variables (or, in the packaged app, from `settings.json`); an unset key SHALL resolve to `undefined`, never to a baked-in credential. The `VOLCES_API_KEY` line SHALL use optional chaining (`process.env.VOLCES_API_KEY?.trim()`), and provider registration SHALL be gated on a `volcesEnabled` boolean derived from the resolved key.

#### Scenario: unset key resolves to undefined
- **WHEN** `VOLCES_API_KEY` is unset in the environment
- **THEN** the resolved key SHALL be `undefined`
- **AND** no fallback credential SHALL be substituted from source
- **AND** the Volces provider SHALL NOT be registered

### Requirement: Asynchronous errors are surfaced, not leaked as unhandled rejections
Every asynchronous WebSocket message handler SHALL catch its own promise rejections and emit an `{ type: "error", message }` message to the originating client rather than leaking an unhandled promise rejection. The cron mutation handlers (`cron_remove`, `cron_pause`, `cron_resume`, `cron_run`) SHALL each wrap their async work in `try/catch`, mirroring `cron_add`. The connect-time `workdirStore.getWorkdir()` promise SHALL have a rejection handler that logs. The `shutdown()` path SHALL wrap the `closeMcpClients` await in `try/catch` so a rejection does not prevent `process.exit(0)`. The reverse-proxy response reads in `createWebProxy` SHALL wrap `await upstreamRes.arrayBuffer()` in `try/catch` and return HTTP 502 on failure.

#### Scenario: a cron handler error is surfaced to the client
- **WHEN** a `cron_remove`, `cron_pause`, `cron_resume`, or `cron_run` handler throws
- **THEN** the server SHALL emit `{ type: "error", message }` to the originating WebSocket client
- **AND** SHALL NOT leak an unhandled promise rejection

#### Scenario: shutdown completes despite closeMcpClients failure
- **WHEN** `closeMcpClients` rejects during shutdown
- **THEN** the server SHALL log the error and SHALL still exit

#### Scenario: proxy response-read failure returns 502
- **WHEN** `await upstreamRes.arrayBuffer()` rejects in `createWebProxy`
- **THEN** the server SHALL respond with HTTP 502 and a message describing the read failure

### Requirement: Server decomposition preserves the external contract
The backend SHALL remain launchable via `node server.js` with the same HTTP route surface (paths, methods, status codes), the same WebSocket message protocol, the same middleware ordering semantics (forward-auth gate before handlers, static + SPA fallback registered last), and the same boot/initialization ordering as the pre-decomposition monolith. Internal code organization into `server/` modules SHALL NOT introduce observable behavior changes.

#### Scenario: e2e suite passes unchanged after extraction
- **WHEN** the full offline e2e `fast` project runs against the decomposed server
- **THEN** all tests that passed pre-decomposition SHALL pass post-decomposition without modification to specs or the frontend

#### Scenario: entrypoint and middleware order are stable
- **WHEN** the server starts via `node server.js` (dev) or the supervisor/packaged launcher
- **THEN** static assets and SPA fallback SHALL remain served after all `/api` routes
- **AND** WebSocket upgrades SHALL pass through the same identity gate as HTTP requests when forward-auth is enabled

#### Scenario: boot initialization ordering is preserved
- **WHEN** the server initializes (db, documents store, dsh agent, legacy migrations, catalog, cron)
- **THEN** initialization SHALL occur in the same relative order as before decomposition, in particular documents-store init before legacy migrations run

### Requirement: Server listens before background initialization completes
The server SHALL accept TCP connections and serve static files and non-agent endpoints within ~1 second of process start, before dsh agent startup, legacy migrations, catalog loading, and cron initialization complete. Initialization groups with no ordering dependency SHALL run concurrently. Endpoints and WebSocket commands that require the dsh agent SHALL respond with an explicit initializing error (HTTP 503 / WS error event) until the agent is ready, and clients SHALL be notified when it becomes ready.

#### Scenario: static assets answer during cold start
- **WHEN** the server process has just started and the dsh agent is still handshaking
- **THEN** an HTTP request for the SPA entry SHALL succeed without waiting for agent readiness

#### Scenario: chat command during initialization
- **WHEN** a client sends a `prompt` WebSocket command before the dsh agent is ready
- **THEN** the server SHALL respond with an initializing error instead of crashing or hanging
- **AND** the server SHALL emit a readiness event to connected clients once the agent is available

#### Scenario: catalog cloud fetch does not block readiness
- **WHEN** the remote agents catalog URL is slow or unreachable (up to its 10s timeout)
- **THEN** the server SHALL already be listening and serving the local catalog
- **AND** cloud catalog entries SHALL merge in when the fetch completes

### Requirement: Shared runtime profile changes are synchronized over WebSocket

The server SHALL expose WebSocket events that distinguish the active shared runtime profile from an identity's private binding state. `runtime_binding` SHALL be broadcast after a successful profile application; `runtime_binding_pending` SHALL be broadcast when a requested profile cannot be applied immediately. These events SHALL include the effective model and MCP availability state needed by the UI but SHALL NOT include an email. A socket with a trusted identity SHALL additionally receive its own `user_bindings` snapshot. Anonymous sockets SHALL receive global runtime state without a personal snapshot.

#### Scenario: clients observe an applied profile
- **WHEN** a personal profile is applied to the shared runtime
- **THEN** all connected clients receive `runtime_binding` with the effective model and MCP availability

#### Scenario: clients observe a deferred profile
- **WHEN** a personal profile is requested while the runtime is busy
- **THEN** clients receive `runtime_binding_pending`
- **AND** the event does not contain the requesting user's email

#### Scenario: authenticated client receives private state
- **WHEN** an authenticated client connects
- **THEN** it receives its own `user_bindings` snapshot in addition to global runtime state

### Requirement: Pending asks are held per session and restored on reconnect

The server SHALL hold at most one pending ask per dsh session, broadcast the question batch to that session's viewers when it arrives, and re-push the pending question during connection sync and session load so a reload or reconnect restores the card. The pending state SHALL be cleared when the ask is answered, cancelled, or failed.

#### Scenario: ask is broadcast to viewers

- **WHEN** an ask arrives for the session a client is viewing
- **THEN** the client receives the question batch associated with that session

#### Scenario: reload restores a pending card

- **WHEN** a client reloads or reconnects while an ask is still pending in the viewed session
- **THEN** the connection sync delivers the pending question so the card renders again

#### Scenario: resolution clears the pending state

- **WHEN** a pending ask is answered, cancelled, or failed
- **THEN** the per-session pending state is cleared and subsequent syncs deliver no pending question

### Requirement: Answer submissions are ownership-checked and first-wins

The server SHALL accept an answer or cancellation for a pending ask only from clients viewing the owning session. The first accepted submission SHALL resolve the ask; later submissions for the same ask SHALL have no effect on the outcome. Every viewer SHALL observe the final resolved state.

#### Scenario: an owning viewer answers

- **WHEN** a client viewing the session submits an answer for the pending ask
- **THEN** the answer is forwarded to the runtime and resolves the ask

#### Scenario: a late second submission is a no-op

- **WHEN** another surface already resolved the pending ask
- **THEN** the later submission changes nothing and the client's card converges to the final answered state

#### Scenario: a foreign client is rejected

- **WHEN** a client not viewing the owning session submits an answer
- **THEN** the submission is rejected without affecting the ask

### Requirement: Bot-session asks never reach the web transcript

An ask originating in a bot session SHALL be routed to that session's registered collector and SHALL NOT be broadcast to web viewers or stored as web-session pending state.

#### Scenario: bot ask stays in its channel

- **WHEN** an ask arrives for a bot session id
- **THEN** no web client receives a question event and no web pending state is created

### Requirement: In-flight turn events are buffered server-side for replay

While a turn is in flight, the server SHALL maintain an in-memory replay log of that turn's run events (`agent_start`, `text`, `thinking`, `tool_start`, `tool_update`, `tool_end`, `skill_use`, and the terminal `done`/`error` ordering as delivered) scoped to the running session, derived from the same emit path that delivers events to viewers. The log SHALL be bounded (event count and serialized size caps); on overflow the log SHALL be dropped and treated as a miss. The log SHALL be cleared when the turn ends (`done` broadcast) and on turn-abort paths, and SHALL NOT survive process restart (no persistence).

#### Scenario: buffer accumulates a live turn

- **WHEN** a turn starts and run events are delivered to viewers
- **THEN** the same events SHALL also be appended to the in-flight turn's replay log in delivery order

#### Scenario: buffer is cleared at turn end

- **WHEN** a turn ends (`done` broadcast)
- **THEN** the replay log for that turn SHALL be cleared

#### Scenario: bounded buffer degrades to a miss

- **WHEN** the replay log exceeds its size or count cap
- **THEN** the log SHALL be dropped and subsequent sync responses for that turn SHALL behave as a buffer miss

#### Scenario: process restart leaves no buffer

- **WHEN** the server process restarts while a turn was in flight
- **THEN** no replay log SHALL exist for that turn (sync falls back to the miss path)

### Requirement: session_loaded carries turn-in-flight status and replay payload

The `session_loaded` response to `switch_session` SHALL include a `running` boolean derived from the server's turn-origin state (`running: true` only when a turn is in flight for the target session). When `running` is true and the replay log is present, the response SHALL also carry the turn's event log so the client can reconstruct the in-flight turn; when `running` is true but the log is absent (miss), the response SHALL carry `running: true` without the log.

When `running` is false, the response SHALL carry a transcript **window** — at most the most recent N turns — together with `totalTurns` and a `hasMore` boolean, rather than the entire transcript. N SHALL be a single constant shared with the client's render window. The response MUST NOT grow linearly with session length in its first frame. The added fields SHALL be optional so older clients ignore them without error: an older client that ignores `hasMore`/`totalTurns` SHALL still receive a valid transcript window and apply its existing replace behavior to it.

#### Scenario: sync during an in-flight turn replays the log

- **WHEN** a client sends `switch_session` for a session whose turn is in flight and the replay log is present
- **THEN** the `session_loaded` response SHALL include `running: true` and the ordered turn event log

#### Scenario: sync with a buffer miss reports running without a log

- **WHEN** a client sends `switch_session` for a session whose turn is in flight but the replay log is absent
- **THEN** the `session_loaded` response SHALL include `running: true` and no turn event log

#### Scenario: sync after the turn ended replaces the transcript

- **WHEN** a client sends `switch_session` for a session with no turn in flight whose transcript has more turns than N
- **THEN** the response SHALL include `running: false` and replace the view with at most the most recent N turns
- **AND** it SHALL include `totalTurns` and `hasMore: true`
- **AND** the first frame's size SHALL NOT scale with the full transcript length

#### Scenario: a short session's window is the whole transcript

- **WHEN** a client sends `switch_session` for a session whose transcript has at most N turns
- **THEN** the response SHALL include the whole transcript with `hasMore: false`

#### Scenario: older clients ignore the new fields

- **WHEN** a client that does not know `running`/turn-event/`hasMore`/`totalTurns` fields receives the extended `session_loaded`
- **THEN** the client SHALL apply its transcript-replace behavior to the received window without error

### Requirement: Earlier transcript pages load on demand

The server SHALL serve earlier turns of a session on request, so a client can page backwards through a long transcript without holding it all in memory. The request SHALL carry the session id and a cursor naming the earliest already-loaded turn (by `seq`); the response SHALL carry the preceding batch of turns in ascending order and a `hasMore` boolean. The request SHALL respect the same session ownership/access rules as `switch_session`. An unknown session or a cursor with no earlier turns SHALL be answered honestly (empty page with `hasMore: false`, or an error), never with a fabricated page.

#### Scenario: paging backwards returns the previous batch

- **WHEN** a client requests earlier turns for a session, giving the seq of its earliest loaded turn
- **THEN** the response SHALL return the preceding batch of turns in ascending order and `hasMore` reflecting whether even earlier turns exist

#### Scenario: oldest page ends the paging

- **WHEN** a client requests earlier turns naming the session's first turn as the cursor
- **THEN** the response SHALL be an empty page with `hasMore: false`

#### Scenario: ownership is enforced on paging

- **WHEN** a client requests earlier turns for a session it is not entitled to
- **THEN** the request SHALL be refused exactly as `switch_session` refuses it

### Requirement: 窗口化转录首帧经压缩传输

服务端与客户端之间的 WebSocket 连接 SHALL 协商 `permessage-deflate`（RFC 7692）。首帧 `session_loaded` 的载荷包含折叠工具块（`blocks`），可见文本只占字节数的 <1%，其余为浏览器折叠后不渲染的工具输出；压缩使该载荷在 wire 上按字节传输，**不改变消息语义、不丢失折叠块、不引入客户端改动**。

#### Scenario: 折叠工具块的首帧按字节传输

- **WHEN** 会话有 50 条消息，合计约 1.3MB JSON（其中 `blocks` 约 99.2%）
- **THEN** 服务端通过 permessage-deflate 帧传输，客户端收到完整载荷，折叠块保留
- **AND** 同一载荷在未压缩时约 1.3MB，压缩后约 100-200KB（视 zlib 窗口）

#### Scenario: 小帧跳过压缩

- **WHEN** 载荷 < 1KB
- **THEN** 服务端不为其建 zlib 上下文（`threshold: 1024`），开销为零

### Requirement: 压缩不改变分页契约

`load_earlier` → `session_page` 分页契约 SHALL 保持不变：`beforeSeq` 游标、升序返回、`hasMore` 布尔值、session 归属校验均不变。`permessage-deflate` 是传输层细节，分页逻辑与客户端窗口大小无关。

#### Scenario: 压缩下分页仍止于首条

- **WHEN** 客户端请求比当前窗口更早的页面，服务端返回空页 + `hasMore: false`
- **THEN** 客户端收到完整载荷（无论是否压缩），分页正常结束
