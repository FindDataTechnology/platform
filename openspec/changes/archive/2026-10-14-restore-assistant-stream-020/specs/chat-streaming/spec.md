# chat-streaming Delta — restore-assistant-stream-020

## MODIFIED Requirements

### Requirement: Assistant text is streamed to clients as deltas
The server SHALL stream assistant text to connected WebSocket clients as incremental `text` events (`{ type: "text", delta }`) as the model produces output, so the UI updates live during a turn. On the 0.2.0 runtime generation the deltas SHALL be sourced from the runtime's assistant-stream channel (frames forwarded by the in-child bridge plugin and keyed by session), not from session-event chunk notifications — which the 0.2.0 session format no longer emits. The bridge SHALL advertise the stream forwarding via the runtime capability surface; when the capability is absent (older runtime or bridge not activated), the server SHALL fall back to emitting the turn's settled assistant text once at settlement, per the exactly-once requirement below. Reasoning deltas arriving on the same channel SHALL be forwarded as `thinking` events (`{ type: "thinking", delta }`), preserving live activity rendering.

#### Scenario: streamed text appears live
- **WHEN** the model emits a text delta during a turn
- **THEN** the server SHALL broadcast a `text` event carrying that delta
- **AND** the UI SHALL append the delta to the current assistant bubble

#### Scenario: deltas arrive from the runtime's assistant-stream channel
- **WHEN** a turn streams on a 0.2.0-generation runtime with the bridge's stream forwarding active
- **THEN** the server SHALL receive the stream frames forwarded by the bridge, keyed to the streaming session
- **AND** SHALL map each text delta to a `text` viewer event without waiting for the turn or step to settle
- **AND** session-event notifications SHALL NOT be relied on to carry those deltas

#### Scenario: reasoning deltas keep the activity stream live
- **WHEN** the runtime forwards a reasoning delta frame during a turn
- **THEN** the server SHALL broadcast a `thinking` event carrying that delta
- **AND** the collapsed-activity rendering SHALL reflect live thinking without tool execution

#### Scenario: capability absence degrades to settled text
- **WHEN** the runtime's capability surface does not advertise stream forwarding
- **THEN** live `text`/`thinking` delta broadcast SHALL be absent for the turn
- **AND** the turn's settled assistant text SHALL be emitted exactly once at settlement (per the exactly-once requirement), so the transcript never ends up without visible body text

#### Scenario: stream failures surface as turn errors
- **WHEN** the runtime forwards a finish frame carrying an error for the session's in-flight request
- **THEN** the server SHALL capture the failure for the affected turn
- **AND** the turn SHALL end with the error surfaced per the failure-rendering behavior, not silently
