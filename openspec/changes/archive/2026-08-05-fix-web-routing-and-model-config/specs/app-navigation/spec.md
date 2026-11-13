## MODIFIED Requirements

### Requirement: Chat session list in the sidebar
The sidebar SHALL render a chat-session list region containing a "+ New chat" action and the list of persisted chat sessions, each row showing its title and last-updated time. The currently active session SHALL be visually distinguished. Clicking a session row SHALL switch the active chat to that session (governed by the `chat-history` capability). The session list SHALL be refreshed when sessions are created, switched, or updated. The "+ New chat" action SHALL navigate the main content area to the chat view (the `/chat` route in the SPA) regardless of which view is currently active, so the user lands on the fresh chat immediately; creating a new chat from a non-chat view SHALL switch the user to the chat view rather than leaving them on the current view.

#### Scenario: session list renders in the sidebar
- **WHEN** the page loads with one or more persisted sessions
- **THEN** the sidebar SHALL list each session's title and last-updated time
- **AND** the active session SHALL be highlighted

#### Scenario: new chat from the sidebar while on the chat view
- **WHEN** the user clicks "+ New chat" while the chat view is active
- **THEN** a new chat session SHALL be created and become the active session
- **AND** the session list SHALL refresh with the new session highlighted
- **AND** the main content area SHALL remain on the chat view

#### Scenario: new chat from a non-chat page
- **WHEN** the user clicks "+ New chat" while a non-chat view (e.g. Documents, Dashboard, History, OpenConnector, LiteLLM) is active
- **THEN** a new chat session SHALL be created and become the active session
- **AND** the main content area SHALL navigate to the chat view
- **AND** the session list SHALL refresh with the new session highlighted

#### Scenario: selecting a session switches chats
- **WHEN** the user clicks a session row
- **THEN** that session SHALL become the active chat
- **AND** its messages SHALL be rendered in the chat view
