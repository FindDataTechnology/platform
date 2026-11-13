# turn-tracing Specification Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
