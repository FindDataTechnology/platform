## ADDED Requirements

### Requirement: Assistant text is streamed to clients as deltas
The server SHALL stream assistant text to connected WebSocket clients as incremental `text` events (`{ type: "text", delta }`) as the model produces output, so the UI updates live during a turn.

#### Scenario: streamed text appears live
- **WHEN** the model emits a text delta during a turn
- **THEN** the server SHALL broadcast a `text` event carrying that delta
- **AND** the UI SHALL append the delta to the current assistant bubble

### Requirement: Each assistant text segment is emitted exactly once per turn
The server SHALL deliver each assistant text segment to clients exactly once per turn. The server SHALL NOT re-broadcast the full assistant text on both `message_end` and `agent_end`; the final text SHALL be emitted at most once, and only as a fallback when no text was streamed during the turn (e.g. a non-streaming model response).

#### Scenario: streaming model response is not duplicated
- **WHEN** the model streams its response via text deltas during the turn
- **THEN** the server SHALL NOT emit the full text again on `message_end` or `agent_end`
- **AND** the rendered assistant text SHALL equal the model's response exactly once

#### Scenario: non-streaming response is emitted once via fallback
- **WHEN** the model produces a response with no streamed text deltas
- **THEN** the server SHALL emit the final assistant text exactly once on turn completion
- **AND** the rendered assistant text SHALL equal the model's response exactly once
