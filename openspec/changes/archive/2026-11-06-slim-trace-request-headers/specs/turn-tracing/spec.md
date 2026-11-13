## MODIFIED Requirements

### Requirement: The server captures the full dsh event stream for every turn

The server SHALL record every dsh runtime notification (session events and status changes) it receives, keyed by turn and session, with per-turn sequence numbers and wall-clock timestamps, into the trace store. Capture failures SHALL be isolated: a trace write error SHALL log a warning and never abort or corrupt the chat turn in flight. Streaming delta notifications (`assistant/chunk` with `text-delta`, `reasoning-delta`, or `tool-call-delta`) SHALL NOT be persisted — their content is already carried by the terminal `assistant/message` event; non-delta chunk notifications (e.g. `finish`, carrying token usage and stop reason) SHALL be persisted.

#### Scenario: ordinary turn captured
- **WHEN** a chat turn runs to completion
- **THEN** every dsh notification emitted during the turn SHALL exist as a trace row carrying the turn id, session id, seq, timestamp, method, event type, and raw payload — with one deliberate exception: the `request/header` event stores its header identity (provider/model config) but not the per-turn tool-roster payload, whose full schema list is consumed in memory only and has no trace reader (storage-bound discipline, openspec: turn-tracing bounded storage)

#### Scenario: trace store failure does not break chat
- **WHEN** writing a trace row throws (e.g. disk error)
- **THEN** the server SHALL log the error and the chat turn SHALL proceed unaffected

#### Scenario: streaming deltas are not persisted
- **WHEN** a turn streams assistant text or reasoning as incremental deltas
- **THEN** no trace row is written for those delta notifications, and the turn's terminal `assistant/message` row still carries the full text

#### Scenario: non-delta chunks are persisted
- **WHEN** the runtime emits a `finish` chunk carrying token usage or stop reason
- **THEN** a trace row for that notification SHALL exist
