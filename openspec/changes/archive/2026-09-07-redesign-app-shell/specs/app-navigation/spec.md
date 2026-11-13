## ADDED Requirements

### Requirement: Sidebar footer is a single status-and-settings row
The sidebar footer SHALL contain exactly one row holding two elements: a connection-status indicator (a coloured dot plus a label reflecting the `connecting` / `connected` / `disconnected` states) and a settings button bearing a gear icon. Activating the settings button SHALL open the Settings modal (see `settings-surface`). The footer SHALL NOT contain an agent selector, a model chip, a "Clear chat" button, or a locale selector. The footer SHALL be present on every page, independent of the active view tab, because it is part of the persistent sidebar shell.

#### Scenario: footer renders only the status indicator and the gear
- **WHEN** the sidebar renders on any route
- **THEN** the footer SHALL display a connection-status indicator and a settings gear button
- **AND** the footer SHALL NOT render an agent selector, a model chip, a "Clear chat" button, or a locale selector

#### Scenario: gear opens the Settings modal
- **WHEN** the user activates the settings gear button in the footer
- **THEN** the Settings modal SHALL open (per `settings-surface`)
- **AND** the view the user was on SHALL remain rendered beneath the modal

#### Scenario: status indicator tracks the connection
- **WHEN** the WebSocket connection state changes between `connecting`, `connected`, and `disconnected`
- **THEN** the footer status indicator SHALL update its dot colour and its localized label to match the new state

## MODIFIED Requirements

### Requirement: Left sidebar navigation shell with a canonical tab set
The web UI SHALL provide a persistent left sidebar navigation containing, in order, the view tabs: **Chat, Knowledge, Agents, Bots, Trace**. These five tabs are the application's *work surfaces* — views the user visits to read or produce content. Configuration surfaces SHALL NOT appear as view tabs: **MCP Servers**, **Skills**, and **Models** are sections of the Settings modal (see `settings-surface`), reached at `/settings/mcp`, `/settings/skills`, and `/settings/models` respectively. The legacy "Dashboard", "Documents", and "Extensions" top-level entries SHALL remain absent; System Status is likewise a Settings section at `/settings/status`. The legacy `/extensions` parent route SHALL NOT be registered. Each view tab SHALL correspond to exactly one main-content panel. On initial load the UI SHALL activate the Chat tab. The sidebar session-list region SHALL remain visible regardless of which view tab is active. The displayed label of each view tab SHALL be resolved from the internationalization (`i18n`) resource bundle, keyed by a stable identifier, so that the label follows the active locale while the tab's identity, ordering, and icon remain stable.

#### Scenario: initial load shows the Chat tab
- **WHEN** the page loads
- **THEN** the sidebar SHALL render the view tabs Chat, Knowledge, Agents, Bots, and Trace
- **AND** the Chat tab SHALL be the active tab
- **AND** the Chat panel SHALL be visible and all other panels SHALL be hidden
- **AND** no Extensions, Dashboard, or Documents top-level entry SHALL be present

#### Scenario: canonical tab ordering and labels
- **WHEN** the sidebar renders
- **THEN** the view tabs SHALL appear in the order Chat, Knowledge, Agents, Bots, Trace
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

#### Scenario: Extensions parent is absent
- **WHEN** the user navigates to `/extensions`
- **THEN** the router SHALL redirect to `/settings/mcp` (the MCP Servers Settings section)
- **AND** no Extensions parent page SHALL be rendered

## REMOVED Requirements

### Requirement: Settings menu in sidebar footer
**Reason**: The footer gear opened a dropdown menu that duplicated nav destinations (LLM Models was reachable both as a nav tab and as a menu item) while being the only path to System Status. The dropdown is replaced by the Settings modal defined in `settings-surface`, which gives every configuration surface exactly one home and one predictable entry point.

**Migration**: The gear button remains in the sidebar footer and remains visible on every page, but it now opens the Settings modal at `/settings/general` instead of a dropdown. Its former menu items map to Settings sections: **System Status** → `/settings/status`, **LLM Models** → `/settings/models`. The modal's own open, dismiss, deep-link, and keyboard-shortcut behavior is specified by `settings-surface`; the footer row that hosts the gear is specified by "Sidebar footer is a single status-and-settings row" in this capability.

### Requirement: Models tab content is now backed by the Models page
**Reason**: Models is a configure-and-leave surface, not a work surface, so it is no longer part of the canonical nav tab set. This requirement asserted the opposite ("The tab MUST continue to be present in the canonical tab set"), which the new navigation contract contradicts.

**Migration**: The Models page content is unchanged — it moves intact into the Settings modal as the `/settings/models` section (see `settings-surface`). The legacy `/models` route SHALL redirect to `/settings/models` so existing deep-links and bookmarks continue to resolve. The page remains the canonical place to add, edit, and remove LLM providers and to set the default model (see `llm-model-management`); per-turn model switching is the composer control strip's job (see `chat-composer-controls` and `model-selection`).
