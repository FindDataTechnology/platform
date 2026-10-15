# system-status-dashboard Specification

## Purpose
TBD - created by archiving change ui-nav-restructure. Update Purpose after archive.
## Requirements
### Requirement: System Status is a Settings section

The System Status surface SHALL be the Settings modal's `status` section at `/settings/status`, titled "System Status" (i18n key `systemStatus.title`). It SHALL be reachable by opening the Settings modal (sidebar gear or `Cmd/Ctrl + ,`) and selecting the System Status section, or by navigating directly to `/settings/status`. It SHALL NOT be a sidebar navigation tab.

The legacy path `/dashboard` SHALL redirect to `/settings/status` so existing deep links and bookmarks continue to resolve rather than 404.

The pane SHALL remain read-only — no configuration actions are exposed here. It SHALL render its existing summary sections (**Health**, **Active Configuration**, **Resources**, and **MCP**), each a summary with a "Manage" link to the surface that controls it. The page component, its sections, and its `data-testid` attributes SHALL be unchanged; only the container changes from a standalone page to a Settings section pane.

#### Scenario: System Status pane renders

- **WHEN** the user opens the Settings modal and selects the System Status section
- **THEN** the URL SHALL be `/settings/status`
- **AND** the pane SHALL render with the Health, Active Configuration, Resources, and MCP sections
- **AND** no configuration action SHALL be offered within the pane itself

#### Scenario: legacy dashboard path redirects

- **WHEN** the user navigates to `/dashboard`
- **THEN** the router SHALL redirect to `/settings/status`
- **AND** the Settings modal SHALL open with the System Status section active

#### Scenario: System Status is absent from the sidebar navigation

- **WHEN** the sidebar renders
- **THEN** no "Dashboard" or "System Status" navigation tab SHALL be present
- **AND** the surface SHALL be reachable only through the Settings modal or its canonical `/settings/status` URL

#### Scenario: page internals and test identifiers are unchanged

- **WHEN** the System Status pane renders inside the Settings modal
- **THEN** every section, counter, and state indicator SHALL behave exactly as it did on the former standalone page
- **AND** every `data-testid` attribute within the pane SHALL retain the value it had before this change

### Requirement: Manage links resolve against the Settings modal

Each section's "Manage" link SHALL target the surface that owns the setting it summarizes. When that target is another Settings section, following the link SHALL switch the active pane within the already-open modal rather than closing it — the modal stays open and only the URL's section segment changes. When that target is a work surface outside Settings, following the link SHALL close the modal and navigate to that surface.

#### Scenario: Manage link to another Settings section switches panes

- **WHEN** the user is viewing the System Status pane and clicks the MCP section's "Manage" link
- **THEN** the URL SHALL become `/settings/mcp`
- **AND** the Settings modal SHALL remain open with the MCP pane active
- **AND** the modal SHALL NOT close or re-open

#### Scenario: Manage link to a work surface leaves Settings

- **WHEN** the user is viewing the System Status pane and clicks the agent row's "Manage" link
- **THEN** the Settings modal SHALL close
- **AND** the application SHALL navigate to the Agents work surface at `/agents`

### Requirement: Health section lists supervised services
The Health section SHALL list every supervised process with a state indicator (healthy / disabled / unhealthy / starting) sourced from `GET /api/supervisor/status`. The state indicator SHALL be color-coded (green / grey / red / amber) consistent with the existing dashboard. Each row SHALL show service name and (when applicable) port. No actions SHALL be available — this is a read-only health summary.

#### Scenario: healthy services shown
- **WHEN** all supervised processes are healthy
- **THEN** the Health section SHALL list each service with a green dot and the localized "healthy" label

### Requirement: Active Configuration section shows current provider, model, and agent
The Active Configuration section SHALL display: current LLM provider name, current model id, and current agent id (local/remote). Each item SHALL have a "Manage" link to the surface that controls it — the provider and model rows link to the Settings modal's Models section at `/settings/models`, and the agent row links to the Agents work surface at `/agents`.

#### Scenario: shows active configuration
- **WHEN** the pane renders
- **THEN** the Active Configuration section SHALL show the current model id, provider name, and agent id from the live state
- **AND** each row SHALL have a clickable link to the surface that controls it

#### Scenario: provider and model links stay within Settings
- **WHEN** the user clicks the "Manage" link on the provider row or the model row
- **THEN** the URL SHALL become `/settings/models`
- **AND** the Settings modal SHALL remain open with the Models pane active

### Requirement: Resources section shows counts
The Resources section SHALL display: total document count, per-status document counts, collection count, and MCP tool count. Counts SHALL be sourced from `GET /api/supervisor/status` (non-secret fields only, same as today). A "Refresh" button SHALL re-fetch the status.

#### Scenario: refresh reloads status
- **WHEN** the user clicks the Refresh button
- **THEN** the page SHALL re-fetch `/api/supervisor/status`
- **AND** update all sections with the new values
- **AND** the button SHALL be disabled while the request is in flight

