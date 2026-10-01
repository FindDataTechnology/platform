# web-chat-ui Specification

## Purpose
The browser chat surface: the conversation view, its composer and controls, the WebSocket-driven message lifecycle, and session navigation affordances.

## Requirements
### Requirement: Chat UI displays messages in a conversation view
The chat UI SHALL display user messages and assistant responses in a scrollable conversation area with distinct styling for each role.

#### Scenario: User sends a message
- **WHEN** the user types a message and submits it
- **THEN** the message SHALL appear in the conversation area with user styling (right-aligned, distinct background)

#### Scenario: Assistant responds with text
- **WHEN** the server sends text deltas for an assistant response
- **THEN** the text SHALL appear incrementally in the conversation area with assistant styling (left-aligned)

### Requirement: Chat UI shows tool execution status
The chat UI SHALL display tool execution start and end events inline with the conversation.

#### Scenario: Agent runs a tool
- **WHEN** the server sends a `tool_start` event
- **THEN** the UI SHALL display a tool indicator showing the tool name with a loading state
- **AND** when `tool_end` arrives, SHALL update the indicator to show success or error

### Requirement: Chat UI supports streaming text input
The chat UI SHALL provide a text input field with a send button and Enter key support for submitting prompts.

#### Scenario: User submits a prompt
- **WHEN** the user types text and presses Enter or clicks the Send button
- **THEN** the prompt SHALL be sent to the server via WebSocket and the input SHALL be cleared

#### Scenario: Empty input is rejected
- **WHEN** the user tries to submit an empty or whitespace-only message
- **THEN** the message SHALL NOT be sent

### Requirement: Chat UI handles WebSocket connection lifecycle
The chat UI SHALL connect to the WebSocket server on page load, display connection status, and reconnect on disconnect using exponential backoff. The reconnect delay SHALL be `min(30000, 1000 * 2^attempt)` milliseconds multiplied by ±25% jitter. The UI SHALL stop scheduling reconnect attempts after a maximum of 20 attempts. The attempt counter SHALL reset to 0 on a successful connection (`onopen`). The UI SHALL listen for the browser `online` event and, when the network is restored, clear any pending reconnect timer, reset the attempt counter, and reconnect immediately — bypassing the backoff. The unmount guard (`cancelled`) SHALL be preserved so a cleaned-up component does not reconnect or schedule further timers.

#### Scenario: connection lost triggers backoff
- **WHEN** the WebSocket connection drops and the component is still mounted
- **THEN** the UI SHALL show a "Disconnected" status
- **AND** SHALL schedule a reconnect after a jittered exponential delay (`min(30000, 1000 * 2^attempt)` × ±25%)

#### Scenario: backoff stops after the cap
- **WHEN** the connection has failed the maximum number of reconnect attempts (20)
- **THEN** the UI SHALL stop scheduling further reconnect attempts

#### Scenario: online event triggers immediate reconnect
- **WHEN** the browser fires the `online` event while disconnected and a reconnect timer may be pending
- **THEN** the UI SHALL clear the pending timer, reset the attempt counter to 0, and reconnect immediately

#### Scenario: successful connection resets the counter
- **WHEN** a reconnect attempt succeeds (`onopen`)
- **THEN** the attempt counter SHALL reset to 0

#### Scenario: unmount stops reconnection
- **WHEN** the component unmounts
- **THEN** the unmount guard SHALL prevent further reconnect attempts and clear any pending timer

### Requirement: Chat UI shows thinking blocks
The chat UI SHALL display thinking content from the agent in a collapsible block.

#### Scenario: Agent produces thinking output
- **WHEN** the server sends a `thinking` delta event
- **THEN** the UI SHALL display the thinking content in a collapsible, visually distinct block

### Requirement: Session opens optimistically with a pending state

When the user activates a session entry (sidebar row, welcome-page recent, tasks/resources jump), the chat view SHALL switch to the target session immediately, showing a pending placeholder for that session instead of the previous session's transcript, without waiting for the server's `session_loaded`. A `session_loaded` that arrives for a session other than the one the client now views SHALL be ignored for transcript replacement. The composer SHALL stay usable-per-existing-rules; the pending state SHALL resolve into the loaded transcript, an error state on failure, or the cached transcript when one exists.

#### Scenario: click gives instant feedback

- **WHEN** the user clicks a session in the sidebar while the previous session's transcript is displayed
- **THEN** the view immediately shows the target session with a pending placeholder
- **AND** the previous transcript is no longer displayed

#### Scenario: a stale load does not clobber the view

- **WHEN** `session_loaded` arrives for session A after the user has already navigated to session B
- **THEN** the client SHALL ignore it for transcript replacement and session B's pending state is unaffected

### Requirement: Visited sessions are cached client-side

The client SHALL retain the rendered turn list of sessions it has loaded and SHALL re-enter a cached session by rendering the cached transcript immediately, refreshing it from the server in the background. A cached entry SHALL be dropped or refreshed when the client receives an event indicating that session changed (turn completed, session deleted). The cache SHALL be bounded (a small LRU of sessions).

#### Scenario: re-entering a visited session is instant

- **WHEN** the user switches from session A to session B and back to session A, and A is cached
- **THEN** A's transcript renders immediately from the cache
- **AND** a background refresh reconciles any changes

#### Scenario: cache does not show completed-away turns as stale

- **WHEN** a turn in session A completes while the user views session B and the completion event for A is received
- **THEN** A's cached entry is refreshed or dropped so the next entry does not render the pre-turn transcript as final

### Requirement: Transcript rendering is windowed

The conversation view SHALL mount only the most recent N turns on session open, with an affordance to load earlier turns in batches. Turn data in the store SHALL remain complete — windowing is a render-layer concern — so features that read the full turn list (outline navigation, export) keep operating on the complete session.

#### Scenario: long session opens without mounting everything

- **WHEN** a session with several hundred turns is opened
- **THEN** only the most recent N turns mount, and the transcript is scrolled to the bottom
- **AND** an affordance to load earlier turns is presented at the top

#### Scenario: loading earlier turns prepends history

- **WHEN** the user activates the load-earlier affordance
- **THEN** the previous batch of turns mounts above the current window without losing scroll position

### Requirement: File previews and downloads show busy states

Every preview-drawer renderer and download action SHALL present a visible busy state while its file content is being fetched, for all preview kinds (not only text-like kinds), and the download affordance SHALL fall back to a plain navigation download if a fetched download cannot be completed.

#### Scenario: large file preview shows a transition

- **WHEN** the drawer opens for a large image, PDF, or download-only file
- **THEN** a busy indicator is displayed until the content is available or the renderer falls back to the download action

#### Scenario: download with fetch falls back on failure

- **WHEN** a fetched (busy-state) download fails
- **THEN** the client SHALL fall back to a plain navigation download of the same URL

