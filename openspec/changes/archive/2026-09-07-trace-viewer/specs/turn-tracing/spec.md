## ADDED Requirements

### Requirement: The server captures the full dsh event stream for every turn
The server SHALL record every dsh runtime notification (session events and status changes) it receives, keyed by turn and session, with per-turn sequence numbers and wall-clock timestamps, into the project SQLite database. Capture failures SHALL be isolated: a trace write error SHALL log a warning and never abort or corrupt the chat turn in flight.

#### Scenario: ordinary turn captured
- **WHEN** a chat turn runs to completion
- **THEN** every dsh notification emitted during the turn SHALL exist as a trace row carrying the turn id, session id, seq, timestamp, method, event type, and raw payload

#### Scenario: trace store failure does not break chat
- **WHEN** writing a trace row throws (e.g. disk error)
- **THEN** the server SHALL log the error and the chat turn SHALL proceed unaffected

### Requirement: Trace data is queryable via REST
The server SHALL expose `GET /api/trace/turns` returning paginated per-turn summaries (turn id, session id, start time, duration, event count, error flag, model/provider when derivable) and `GET /api/trace/turns/:id` returning the turn's events in original order with a derived one-line summary per known event type and the raw payload. An unknown turn id SHALL return 404; an empty store SHALL return an empty list.

#### Scenario: list turns
- **WHEN** a client requests `/api/trace/turns`
- **THEN** the server SHALL return turn summaries ordered newest-first with pagination

#### Scenario: turn detail
- **WHEN** a client requests `/api/trace/turns/:id` for a captured turn
- **THEN** the response SHALL include the ordered events with summaries and raw payloads, including event types not rendered by the chat protocol (e.g. request headers, LLM retries, step boundaries)

### Requirement: The UI renders a per-turn trace viewer
The web app SHALL provide a `/trace` route listing captured turns and a `/trace/:turnId` route rendering the turn's ordered event timeline with expandable raw payloads and derived sections (LLM calls including retries, tool calls with durations, aggregated delta counts), reachable from the sidebar navigation.

#### Scenario: inspecting a slow turn
- **WHEN** the user opens a turn in `/trace/:turnId`
- **THEN** the timeline SHALL show each LLM request with any retries and each tool call with its duration, in order

### Requirement: Trace storage is bounded
The server SHALL prune trace rows older than the retention window (`TRACE_RETENTION_DAYS`, default 14) at startup.

#### Scenario: retention prune
- **WHEN** the server starts with trace rows older than the window present
- **THEN** those rows SHALL be deleted
