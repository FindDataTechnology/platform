## MODIFIED Requirements

### Requirement: Left sidebar navigation shell with a canonical tab set
The web UI SHALL provide a persistent left sidebar navigation containing, in order, the view tabs: Chat, Documents, and OpenConnector. The standalone "Chat History" tab SHALL be removed; chat sessions are instead surfaced as a session-list region within the sidebar. Each view tab SHALL correspond to exactly one main-content panel. On initial load the UI SHALL activate the Chat tab. The sidebar session-list region SHALL remain visible regardless of which view tab is active.

#### Scenario: initial load shows the Chat tab
- **WHEN** the page loads
- **THEN** the sidebar SHALL render the view tabs Chat, Documents, and OpenConnector
- **AND** the Chat tab SHALL be the active tab
- **AND** the Chat panel SHALL be visible and all other panels SHALL be hidden

#### Scenario: canonical tab ordering and labels
- **WHEN** the sidebar renders
- **THEN** the view tabs SHALL appear in the order Chat, Documents, OpenConnector
- **AND** each tab SHALL display a stable label and icon
- **AND** no standalone "Chat History" tab SHALL be present

## ADDED Requirements

### Requirement: Chat session list in the sidebar
The sidebar SHALL render a chat-session list region containing a "+ New chat" action and the list of persisted chat sessions, each row showing its title and last-updated time. The currently active session SHALL be visually distinguished. Clicking a session row SHALL switch the active chat to that session (governed by the `chat-history` capability). The session list SHALL be refreshed when sessions are created, switched, or updated.

#### Scenario: session list renders in the sidebar
- **WHEN** the page loads with one or more persisted sessions
- **THEN** the sidebar SHALL list each session's title and last-updated time
- **AND** the active session SHALL be highlighted

#### Scenario: new chat from the sidebar
- **WHEN** the user clicks "+ New chat"
- **THEN** a new chat session SHALL be created and become the active session
- **AND** the session list SHALL refresh with the new session highlighted

#### Scenario: selecting a session switches chats
- **WHEN** the user clicks a session row
- **THEN** that session SHALL become the active chat
- **AND** its messages SHALL be rendered in the chat view

### Requirement: LiteLLM management entry in the sidebar
The sidebar SHALL render a LiteLLM nav entry that opens the LiteLLM proxy's management UI (`${LITELLM_BASE_URL}/ui`) in a new browser tab. The entry SHALL be shown only when LiteLLM is configured; when LiteLLM is not configured the entry SHALL be absent. The previous footer management link SHALL be removed.

#### Scenario: entry shown when LiteLLM is configured
- **WHEN** the page loads and the server configuration includes a LiteLLM management URL
- **THEN** the sidebar SHALL render a LiteLLM nav entry

#### Scenario: entry hidden when LiteLLM is not configured
- **WHEN** the page loads and LiteLLM is not configured
- **THEN** the sidebar SHALL NOT render a LiteLLM nav entry

#### Scenario: opening the management UI
- **WHEN** the user clicks the LiteLLM nav entry
- **THEN** the browser SHALL open the LiteLLM management UI in a new tab
