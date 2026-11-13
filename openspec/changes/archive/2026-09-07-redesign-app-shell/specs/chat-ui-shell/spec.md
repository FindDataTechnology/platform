## MODIFIED Requirements

### Requirement: Chat page has a header when turns exist
When the chat page has at least one turn (a session is loaded or in progress), the page SHALL render a **session header** above the message log. The header SHALL contain exactly two elements: an editable title (click-to-edit text input that commits on Enter, cancels on Escape, debounced 300ms) and an overflow (`⋯`) trigger.

Activating the overflow trigger SHALL open the session context menu for the **active** session — the same menu component that opens on right-click of a session row in the sidebar (see `session-list-management`), so there is one menu with two triggers rather than two parallel menus.

The header SHALL NOT display the current model name, the current agent name, or a connection-status dot. That state is reported once elsewhere in the shell: model and agent by the composer control strip (see `chat-composer-controls`), which is on screen whenever a turn can be sent and is also where those values are *changed*; connection status by the sidebar footer row (see `app-navigation`). Repeating them in the header gave the user three places to read the same value and no place to act on it.

The header SHALL be sticky to the top of the chat area and SHALL NOT obscure the message log on scroll.

#### Scenario: header shows the title and the overflow trigger
- **WHEN** the chat page has turns
- **THEN** the session header SHALL display the session title and an overflow (`⋯`) trigger
- **AND** the header SHALL be visible above the message log

#### Scenario: header does not duplicate runtime state
- **WHEN** the session header renders
- **THEN** it SHALL NOT render the current model name, the current agent name, or a connection-status dot
- **AND** the current model and agent SHALL be readable from the composer control strip
- **AND** the connection status SHALL be readable from the sidebar footer row

#### Scenario: overflow trigger opens the session menu
- **WHEN** the user activates the overflow (`⋯`) trigger in the header
- **THEN** the session context menu SHALL open for the currently active session
- **AND** the menu SHALL be the same component and offer the same actions as the menu opened by right-clicking that session's row in the sidebar
- **AND** the menu SHALL be dismissable by clicking outside, pressing Escape, or selecting an item

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
