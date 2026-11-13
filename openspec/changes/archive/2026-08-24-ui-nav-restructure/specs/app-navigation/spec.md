# app-navigation delta

## MODIFIED Requirements

### Requirement: Left sidebar navigation shell with a canonical tab set
The web UI SHALL provide a persistent left sidebar navigation containing, in order, the view tabs: **Chat, Knowledge, Agents, MCP Servers, Skills, Models**. The Models tab SHALL be present in v1 as a placeholder route (filled in by the `dsh-llm-models-page` change). The legacy "Dashboard", "Documents", "Extensions", and "OpenConnector" top-level entries SHALL be removed; their content moves to dedicated pages (`/dashboard` is renamed to `/dashboard` "System Status" surfaced under Settings; `/openconnector` is surfaced under Settings). The legacy `/extensions` parent route SHALL NOT be registered — MCP and Skills are direct top-level routes. Each view tab SHALL correspond to exactly one main-content panel. On initial load the UI SHALL activate the Chat tab. The sidebar session-list region SHALL remain visible regardless of which view tab is active. The displayed label of each view tab SHALL be resolved from the internationalization (`i18n`) resource bundle, keyed by a stable identifier, so that the label follows the active locale while the tab's identity, ordering, and icon remain stable.

#### Scenario: initial load shows the Chat tab
- **WHEN** the page loads
- **THEN** the sidebar SHALL render the view tabs Chat, Knowledge, Agents, MCP Servers, Skills, and Models
- **AND** the Chat tab SHALL be the active tab
- **AND** the Chat panel SHALL be visible and all other panels SHALL be hidden
- **AND** no Extensions, Dashboard, Documents, or OpenConnector top-level entry SHALL be present

#### Scenario: canonical tab ordering and labels
- **WHEN** the sidebar renders
- **THEN** the view tabs SHALL appear in the order Chat, Knowledge, Agents, MCP Servers, Skills, Models
- **AND** each tab SHALL display a label resolved from the `common` i18n bundle under a stable key, alongside a stable icon
- **AND** the tab's stable identifier and ordering SHALL NOT change when the active locale changes

#### Scenario: Documents tab renamed to Knowledge
- **WHEN** the user views the sidebar in any locale
- **THEN** the tab previously labelled "Documents" SHALL be labelled "Knowledge"
- **AND** the underlying route SHALL be `/knowledge`
- **AND** the existing `/documents` route SHALL redirect to `/knowledge` (301 or in-app Navigate) so legacy deep-links do not 404

#### Scenario: Extensions parent is absent
- **WHEN** the user navigates to `/extensions`
- **THEN** the router SHALL redirect to `/mcp` (the previously nested "MCP Servers" tab)
- **AND** no Extensions parent page SHALL be rendered

## ADDED Requirements

### Requirement: Settings menu in sidebar footer
The web UI SHALL provide a Settings entry in the sidebar footer, presented as a button with a gear icon. Clicking the entry SHALL open a menu with the items: **System Status**, **LLM Models**, **OpenConnector**. Selecting an item SHALL navigate to the corresponding route. The menu SHALL be dismissable by clicking outside, pressing Escape, or selecting an item. The Settings entry SHALL be visible on every page (it is part of the persistent sidebar shell), independent of the active view tab.

#### Scenario: Settings menu opens and navigates
- **WHEN** the user clicks the Settings gear icon
- **THEN** a dropdown menu SHALL appear with the three items
- **WHEN** the user clicks "OpenConnector"
- **THEN** the router SHALL navigate to `/openconnector`
- **AND** the menu SHALL close

#### Scenario: Settings menu dismissable
- **WHEN** the Settings menu is open and the user presses Escape
- **THEN** the menu SHALL close without navigating
- **WHEN** the user clicks outside the menu
- **THEN** the menu SHALL close without navigating
