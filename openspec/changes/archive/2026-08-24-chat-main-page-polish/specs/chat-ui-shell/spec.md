# chat-ui-shell delta

## ADDED Requirements

### Requirement: Chat page has a header when turns exist
When the chat page has at least one turn (a session is loaded or in progress), the page SHALL render a **session header** above the message log. The header SHALL contain: an editable title (click-to-edit text input that commits on Enter, cancels on Escape, debounced 300ms), the current model name, the current agent name, and a connection-status dot. The header SHALL be sticky to the top of the chat area and SHALL NOT obscure the message log on scroll.

#### Scenario: header shows current state
- **WHEN** the chat page has turns
- **THEN** the session header SHALL display the session title, current model id, current agent id, and the WS connection status dot
- **AND** the header SHALL be visible above the message log

#### Scenario: rename session
- **WHEN** the user clicks the title in the header
- **THEN** the title SHALL become editable
- **WHEN** the user types a new title and presses Enter
- **THEN** the client SHALL send a `rename_session` WS message
- **AND** the server SHALL broadcast a `session_renamed` event
- **AND** all connected clients (including the sender) SHALL update the title in the sidebar session list

#### Scenario: cancel rename
- **WHEN** the user is editing the title and presses Escape
- **THEN** the edit SHALL be cancelled and the original title SHALL be restored

### Requirement: Welcome state is the empty page
When the chat page has no turns, the page SHALL render the Welcome state (see `chat-welcome-state`) instead of an empty message log. The two states (welcome vs in-session) are mutually exclusive — exactly one is visible at a time. The transition is driven by `turns.length === 0` in the chat store.

#### Scenario: switch from welcome to in-session
- **WHEN** the user sends the first message
- **THEN** the welcome state SHALL be replaced by the message log and session header
- **WHEN** the user clears the chat (clearView action)
- **THEN** the in-session state SHALL be replaced by the welcome state

### Requirement: Session-switch broadcasts `session_renamed`
The WS protocol SHALL add a `session_renamed` server event with payload `{ id, title }`. The event MUST be broadcast to every connected client on a successful rename. The client store SHALL update the matching session's title in `sessions[]`. The legacy behavior (no rename event) is preserved for clients on the old protocol — they simply don't update the title until the next `sessions` refresh.

#### Scenario: rename broadcasts to all clients
- **WHEN** client A renames session S to "New title"
- **THEN** every connected client (including A) SHALL receive a `session_renamed` event with `{ id: S, title: "New title" }`
- **AND** each client's `sessions[]` entry for S SHALL reflect the new title

#### Scenario: rename event is sent on WS path too
- **WHEN** a client sends `{ type: "rename_session", id, title }`
- **THEN** the server SHALL broadcast a `session_renamed` event in the same manner as the REST path
