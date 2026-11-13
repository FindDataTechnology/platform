## MODIFIED Requirements

### Requirement: Left sidebar navigation shell with a canonical tab set
The web UI SHALL provide a persistent left sidebar navigation containing, in order, the view tabs: **Chat, Knowledge, Resources, Agents, Bots, Trace, Tasks**. These seven tabs are the application's *work surfaces* — views the user visits to read or produce content. Configuration surfaces SHALL NOT appear as view tabs: **MCP Servers**, **Skills**, and **Models** are sections of the Settings modal (see `settings-surface`), reached at `/settings/mcp`, `/settings/skills`, and `/settings/models` respectively. The legacy "Dashboard", "Documents", and "Extensions" top-level entries SHALL remain absent; System Status is likewise a Settings section at `/settings/status`. The legacy `/extensions` parent route SHALL NOT be registered. Each view tab SHALL correspond to exactly one main-content panel; the Resources tab's panel is the resources page at `/resources`. On initial load the UI SHALL activate the Chat tab. The sidebar session-list region SHALL remain visible regardless of which view tab is active. The displayed label of each view tab SHALL be resolved from the internationalization (`i18n`) resource bundle, keyed by a stable identifier, so that the label follows the active locale while the tab's identity, ordering, and icon remain stable.

#### Scenario: initial load shows the Chat tab
- **WHEN** the page loads
- **THEN** the sidebar SHALL render the view tabs Chat, Knowledge, Resources, Agents, Bots, Trace, and Tasks
- **AND** the Chat tab SHALL be the active tab
- **AND** the Chat panel SHALL be visible and all other panels SHALL be hidden
- **AND** no Extensions, Dashboard, or Documents top-level entry SHALL be present

#### Scenario: canonical tab ordering and labels
- **WHEN** the sidebar renders
- **THEN** the view tabs SHALL appear in the order Chat, Knowledge, Resources, Agents, Bots, Trace, Tasks
- **AND** each tab SHALL display a label resolved from the `common` i18n bundle under a stable key, alongside a stable icon
- **AND** the tab's stable identifier and ordering SHALL NOT change when the active locale changes

#### Scenario: configuration surfaces are absent from the nav
- **WHEN** the sidebar renders
- **THEN** no nav tab SHALL be present for MCP Servers, Skills, Models, or System Status
- **AND** those surfaces SHALL be reachable only as Settings sections (per `settings-surface`)

#### Scenario: Documents tab renamed to Knowledge
- **WHEN** the user views the sidebar in any locale
- **THEN** the tab previously labelled "Documents" SHALL be labelled "Knowledge"
- **AND** the underlying route SHALL be `/knowledge`
- **AND** the existing `/documents` route SHALL redirect to `/knowledge` (301 or in-app Navigate) so legacy deep-links do not 404

#### Scenario: Resources tab opens the resources page
- **WHEN** the user clicks the Resources tab, or navigates directly to `/resources`
- **THEN** the resources page SHALL render as the active panel

#### Scenario: Extensions parent is absent
- **WHEN** the user navigates to `/extensions`
- **THEN** the router SHALL redirect to `/settings/mcp` (the MCP Servers Settings section)
- **AND** no Extensions parent page SHALL be rendered