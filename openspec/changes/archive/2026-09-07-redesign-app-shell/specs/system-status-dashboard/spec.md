## ADDED Requirements

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

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: System Status page is reachable from the Settings menu

**Reason**: The sidebar Settings popover menu that this requirement referred to is deleted by this change and replaced by the routed Settings modal. The surface is no longer a standalone page at `/dashboard` reached from a menu — it is a section of the modal itself. The requirement's scenario also described three sections, which had drifted from the four the page actually renders (Health, Active Configuration, Resources, MCP).

**Migration**: Use `/settings/status`, reachable by opening the Settings modal from the sidebar gear or `Cmd/Ctrl + ,` and selecting System Status. The legacy `/dashboard` path redirects there. The page content, its sections, and its read-only nature are unchanged. See the new requirement "System Status is a Settings section".
