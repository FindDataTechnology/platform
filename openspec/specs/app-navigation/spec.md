# app-navigation Specification

## Purpose
The application's left sidebar navigation shell: a canonical tab set (including the Bots entry) with exactly one visible panel per selected tab, the chat session list, the label-free drag-drop overlay, a single status-and-settings footer row, and the collapsible desktop navigation rail.

## Requirements
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

### Requirement: Chat session list in the sidebar
The sidebar SHALL render a Workspaces session region containing a "+ New
chat" action, a Workspaces header (per the `sidebar-workspaces` capability),
and the persisted chat sessions grouped by their recorded workspace, each
row showing its title and last-updated time. The currently active session
SHALL be visually distinguished. Clicking a session row SHALL switch the
active chat to that session (governed by the `chat-history` capability). The
session list SHALL be refreshed when sessions are created, switched, or
updated. The "+ New chat" action SHALL navigate the main content area to the
chat view (the `/chat` route in the SPA) regardless of which view is
currently active, so the user lands on the fresh chat immediately; creating a
new chat from a non-chat view SHALL switch the user to the chat view rather
than leaving them on the current view.

#### Scenario: session list renders in the sidebar
- **WHEN** the page loads with one or more persisted sessions
- **THEN** the sidebar SHALL list each session's title and last-updated
  time, grouped under its recorded workspace
- **AND** the active session SHALL be highlighted

#### Scenario: new chat from the sidebar while on the chat view
- **WHEN** the user clicks "+ New chat" while the chat view is active
- **THEN** a new chat session SHALL be created and become the active session
- **AND** the session list SHALL refresh with the new session highlighted
- **AND** the main content area SHALL remain on the chat view

#### Scenario: new chat from a non-chat page
- **WHEN** the user clicks "+ New chat" while a non-chat view (e.g. Documents, Dashboard, History) is active
- **THEN** a new chat session SHALL be created and become the active session
- **AND** the main content area SHALL navigate to the chat view
- **AND** the session list SHALL refresh with the new session highlighted

#### Scenario: selecting a session switches chats
- **WHEN** the user clicks a session row
- **THEN** that session SHALL become the active chat
- **AND** its messages SHALL be rendered in the chat view

### Requirement: Drag-drop overlay is subtle and label-free
The drag-drop overlay SHALL NOT display a prominent text label such as "Drop files to add to documents". Drop feedback SHALL be conveyed by a transient toast and the chat-view document banner; the overlay, if shown during a drag, SHALL be a subtle visual affordance without prominent text.

#### Scenario: dragging a file shows no prominent label
- **WHEN** the user drags a file over the page
- **THEN** the overlay SHALL NOT display a prominent text label
- **AND** drop feedback SHALL be conveyed by the toast and/or the chat-view document banner

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

### Requirement: Sidebar navigation includes a Bots entry
The sidebar SHALL include a "Bots" navigation entry linking to the `/bots` route, localized in all supported languages.

#### Scenario: navigation to bots management
- **WHEN** the user clicks the Bots entry in the sidebar
- **THEN** the app SHALL navigate to `/bots` without a page reload, keeping the WebSocket connected

### Requirement: The desktop navigation rail is collapsible
On md+ viewports the sidebar rail SHALL be collapsible: a toggle in the
sidebar header collapses the rail, a re-expand affordance SHALL remain
reachable while collapsed (pinned at the top of the content area), and
Ctrl/Cmd+B SHALL toggle the rail in both directions. The collapsed state
SHALL persist across reloads per browser. Navigation content (tab set,
session region, footer) is unchanged, and the below-md off-canvas drawer
SHALL behave exactly as before.

#### Scenario: collapse from the header toggle
- **WHEN** the user clicks the collapse toggle on a desktop viewport
- **THEN** the rail collapses and the content column takes the full width

#### Scenario: restore while collapsed
- **WHEN** the rail is collapsed and the user clicks the pinned re-expand
  affordance
- **THEN** the rail is restored with the same nav content

#### Scenario: keyboard toggle
- **WHEN** the user presses Ctrl/Cmd+B on a desktop viewport
- **THEN** the rail toggles between collapsed and expanded

#### Scenario: collapse persists across reloads
- **WHEN** the user collapses the rail and reloads the page on the same
  browser
- **THEN** the rail loads collapsed

#### Scenario: narrow viewport keeps the drawer
- **WHEN** the viewport is below md
- **THEN** the collapse toggle is not shown and the off-canvas drawer works
  as before

