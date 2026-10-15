# turn-tracing Specification

## Purpose

Defines the platform's per-turn observability: every dsh runtime notification for every turn is captured into a dedicated, bounded trace store, exposed over REST, and rendered as a per-turn timeline so a slow or failing turn can be diagnosed from the UI rather than from server logs. Trace data is observational — bounded by a retention window and independent of the session index, so its absence never affects chat readability.

## Requirements

### Requirement: The server captures the full dsh event stream for every turn

The server SHALL record every dsh runtime notification (session events and status changes) it receives, keyed by turn and session, with per-turn sequence numbers and wall-clock timestamps, into the trace store. Capture failures SHALL be isolated: a trace write error SHALL log a warning and never abort or corrupt the chat turn in flight. Streaming delta notifications (`assistant/chunk` with `text-delta`, `reasoning-delta`, or `tool-call-delta`) SHALL NOT be persisted — their content is already carried by the terminal `assistant/message` event; non-delta chunk notifications (e.g. `finish`, carrying token usage and stop reason) SHALL be persisted.

#### Scenario: ordinary turn captured
- **WHEN** a chat turn runs to completion
- **THEN** every dsh notification emitted during the turn SHALL exist as a trace row carrying the turn id, session id, seq, timestamp, method, event type, and raw payload

#### Scenario: trace store failure does not break chat
- **WHEN** writing a trace row throws (e.g. disk error)
- **THEN** the server SHALL log the error and the chat turn SHALL proceed unaffected

#### Scenario: streaming deltas are not persisted
- **WHEN** a turn streams assistant text or reasoning as incremental deltas
- **THEN** no trace row is written for those delta notifications, and the turn's terminal `assistant/message` row still carries the full text

#### Scenario: non-delta chunks are persisted
- **WHEN** the runtime emits a `finish` chunk carrying token usage or stop reason
- **THEN** a trace row for that notification SHALL exist

### Requirement: Trace data is queryable via REST

The server SHALL expose `GET /api/trace/turns` returning paginated per-turn summaries (turn id, session id, start time, duration, event count, error flag, model/provider when derivable) and `GET /api/trace/turns/:id` returning the turn's events in original order with a derived one-line summary per known event type and the raw payload. An unknown turn id SHALL return 404; an empty store SHALL return an empty list.

#### Scenario: list turns
- **WHEN** a client requests `/api/trace/turns`
- **THEN** the server SHALL return turn summaries ordered newest-first with pagination

#### Scenario: turn detail
- **WHEN** a client requests `/api/trace/turns/:id` for a captured turn
- **THEN** the response SHALL include the ordered events with summaries and raw payloads, including event types not rendered by the chat protocol (e.g. request headers, LLM retries, step boundaries)

### Requirement: The UI renders a per-turn trace viewer
The list of captured turns SHALL render as the Settings 诊断 (`diagnostics`) section at `/settings/diagnostics`, and the legacy `/trace` route SHALL redirect there. The per-turn viewer SHALL remain a top-level route: `/trace/:turnId` renders the turn's ordered event timeline with expandable raw payloads and derived sections (LLM calls including retries, tool calls with durations, aggregated delta counts). Per-turn deep links from the chat surface (opening a specific turn's trace) SHALL continue to land directly on `/trace/:turnId` unchanged.

#### Scenario: inspecting a slow turn
- **WHEN** the user opens a turn in `/trace/:turnId`
- **THEN** the timeline SHALL show each LLM request with any retries and each tool call with its duration, in order

#### Scenario: trace list lives in Settings
- **WHEN** the user opens Settings and selects the 诊断 (diagnostics) section
- **THEN** the captured-turn list SHALL render inside the Settings modal with its existing filters and columns
- **AND** navigating to `/trace` SHALL redirect to `/settings/diagnostics`

#### Scenario: chat deep link bypasses the list
- **WHEN** the user activates a turn's trace link in the chat surface
- **THEN** the app SHALL navigate directly to `/trace/:turnId` as a top-level page, without passing through the Settings modal

### Requirement: Trace storage is bounded

The server SHALL store trace rows in a dedicated trace database file, separate from the session index database, so that trace retention and session data are independent. The server SHALL prune trace rows older than the retention window (`TRACE_RETENTION_DAYS`, default 7) on a periodic schedule (hourly, not only at process start), so a long-resident cell's trace store remains bounded. After pruning, the server SHALL reclaim freed space (incremental or full vacuum) so the file does not grow monotonically.

#### Scenario: retention prune
- **WHEN** the server starts with trace rows older than the window present
- **THEN** those rows SHALL be deleted

#### Scenario: periodic prune on a long-resident cell
- **WHEN** a cell has been running for longer than the retention window without restart
- **THEN** rows older than the window SHALL be deleted by the periodic prune without a restart

#### Scenario: trace store is a separate file
- **WHEN** the server initializes its stores
- **THEN** trace rows live in a trace database file distinct from the session index database, and deleting or vacuuming trace data does not modify the session index

#### Scenario: space is reclaimed after prune
- **WHEN** a prune deletes rows
- **THEN** the freed space SHALL be reclaimed so the trace database file shrinks or stops growing with the deleted volume

### Requirement: Existing trace rows move to the trace database without loss

The server SHALL migrate pre-existing trace rows from the session index database into the dedicated trace database, preserving `turn_id`, `session_id`, `seq`, `ts`, `method`, `event_type`, and payload, and SHALL remove them from the session index database. The migration SHALL be a pure move with no age filter of its own — bounding is then enforced by the same retention policy as new rows, so a moved row older than the window is pruned in the same boot. Trace rows for delegated subagent sessions SHALL be migrated like any other row. The move SHALL be idempotent (safe to re-run after a crash mid-move) and its failure SHALL NOT disable tracing.

#### Scenario: legacy rows are moved, not dropped
- **WHEN** the server starts with trace rows within the retention window present in the session index database
- **THEN** those rows appear in the trace database with identical column values, and the session index database no longer holds them

#### Scenario: the retention window applies to moved rows
- **WHEN** a pre-existing trace row is older than the retention window
- **THEN** it is moved and then pruned by the same policy as new rows, rather than kept because it arrived through the migration

#### Scenario: subagent trace rows are preserved
- **WHEN** a trace row belongs to a delegated subagent session
- **THEN** it is migrated like any other row

#### Scenario: a failed move does not disable tracing
- **WHEN** the move throws partway (e.g. a locked index database)
- **THEN** the trace store still accepts new rows, and the next boot retries the move without duplicating what already landed
