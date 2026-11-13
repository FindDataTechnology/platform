## ADDED Requirements

### Requirement: Left sidebar navigation shell with a canonical tab set
The web UI SHALL provide a persistent left sidebar navigation containing, in order, the tabs: Chat, Chat History, Documents, and OpenConnector. The sidebar SHALL replace the previous header toggle buttons. Each tab SHALL correspond to exactly one main-content panel. On initial load the UI SHALL activate the Chat tab.

#### Scenario: initial load shows the Chat tab
- **WHEN** the page loads
- **THEN** the sidebar SHALL render all four tabs
- **AND** the Chat tab SHALL be the active tab
- **AND** the Chat panel SHALL be visible and all other panels SHALL be hidden

#### Scenario: canonical tab ordering and labels
- **WHEN** the sidebar renders
- **THEN** the tabs SHALL appear in the order Chat, Chat History, Documents, OpenConnector
- **AND** each tab SHALL display a stable label and icon

### Requirement: Selecting a tab shows its panel and hides the others
The UI SHALL switch the main content area to the selected tab's panel when the user clicks a sidebar tab. The previously active panel SHALL be hidden. The active tab SHALL be visually distinguished from inactive tabs.

#### Scenario: user switches tabs
- **WHEN** the user clicks the "Documents" tab while the Chat tab is active
- **THEN** the Documents panel SHALL become visible
- **AND** the Chat panel SHALL be hidden
- **AND** the "Documents" tab SHALL be marked active and the "Chat" tab SHALL be marked inactive

#### Scenario: only one panel visible at a time
- **WHEN** any tab is active
- **THEN** exactly one main-content panel SHALL be visible
- **AND** no two panels SHALL be visible simultaneously
