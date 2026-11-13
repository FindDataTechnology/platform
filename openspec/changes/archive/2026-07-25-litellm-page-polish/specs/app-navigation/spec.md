## MODIFIED Requirements

### Requirement: Left sidebar navigation shell with a canonical tab set
The web UI SHALL provide a persistent left sidebar navigation containing, in order, the view tabs: Chat, Dashboard, Documents, OpenConnector, and LiteLLM (the LiteLLM tab SHALL be present only when LiteLLM is configured, per the "LiteLLM management entry in the sidebar" requirement). The standalone "Chat History" tab and its `/history` route SHALL be removed; chat sessions are instead surfaced as a session-list region within the sidebar (per the "Chat session list in the sidebar" requirement). Each view tab SHALL correspond to exactly one main-content panel. On initial load the UI SHALL activate the Chat tab. The sidebar session-list region SHALL remain visible regardless of which view tab is active.

#### Scenario: initial load shows the Chat tab
- **WHEN** the page loads
- **THEN** the sidebar SHALL render the view tabs Chat, Dashboard, Documents, and OpenConnector (and LiteLLM when configured)
- **AND** the Chat tab SHALL be the active tab
- **AND** the Chat panel SHALL be visible and all other panels SHALL be hidden

#### Scenario: canonical tab ordering and labels
- **WHEN** the sidebar renders
- **THEN** the view tabs SHALL appear in the order Chat, Dashboard, Documents, OpenConnector, LiteLLM (when configured)
- **AND** each tab SHALL display a stable label and icon
- **AND** no standalone "Chat History" tab SHALL be present
- **AND** no `/history` route SHALL be registered

#### Scenario: History route is absent
- **WHEN** the user navigates to `/history`
- **THEN** the router SHALL NOT render a dedicated History page
- **AND** SHALL redirect to the default chat route (the session list in the sidebar remains the sole session-access surface)
