## MODIFIED Requirements

### Requirement: Market catalog is browsable
The UI SHALL present a market tab displaying a curated catalog of MCP servers and skills, organized by category (e.g., productivity, development, data, communication). Each MCP catalog entry SHALL carry a derived `requiresConfig` flag indicating whether the server needs user-supplied configuration (a secret or path) before it can connect. Entries with `requiresConfig === false` ("ready to use") SHALL be ordered before entries with `requiresConfig === true` ("needs config"), so servers usable out of the box surface first.

#### Scenario: user browses market catalog
- **WHEN** user navigates to the market tab
- **THEN** the UI SHALL display a list of available MCP servers and skills
- **AND** each item SHALL show name, description, category, and an "Install" button
- **AND** items SHALL be filterable by category

#### Scenario: user searches market
- **WHEN** user types in a search box
- **THEN** the UI SHALL filter the catalog to items matching the search query

#### Scenario: ready-to-use servers are ordered first
- **WHEN** the market catalog is rendered
- **THEN** every MCP server with `requiresConfig === false` SHALL appear before any server with `requiresConfig === true`
- **AND** within each group entries SHALL be ordered by name

#### Scenario: each MCP card shows a config-requirement badge
- **WHEN** an MCP market card is rendered
- **THEN** the card SHALL display a badge derived from the entry's `requiresConfig` flag
- **AND** a `requiresConfig === false` entry SHALL show a "ready to use" badge
- **AND** a `requiresConfig === true` entry SHALL show a "needs config" badge

### Requirement: One-click install from market
The UI SHALL allow users to install an MCP server or skill from the market. Clicking "Install" on an MCP server SHALL always open the MCP setup form (see the *MCP setup form is generated from config template* requirement in `extension-management-ui`) pre-filled from the catalog template, so the user can confirm or rename before adding. For servers whose `requiresConfig` is `false`, the form has no fillable config fields (only the name), so the Add button is enabled immediately. For servers whose `requiresConfig` is `true`, the form shows labeled fields the user must fill before Add is enabled.

#### Scenario: user installs a ready-to-use MCP server from market
- **WHEN** user clicks "Install" on an MCP server whose `requiresConfig` is `false`
- **THEN** the system SHALL open the MCP setup form pre-filled from the entry's `configTemplate`
- **AND** the form SHALL show no fillable config fields (only the prefilled name)
- **AND** the Add button SHALL be enabled immediately
- **WHEN** the user clicks Add
- **THEN** the server SHALL be added from the template and SHALL appear in the "Installed" tab

#### Scenario: user installs a needs-config MCP server from market
- **WHEN** user clicks "Install" on an MCP server whose `requiresConfig` is `true`
- **THEN** the system SHALL open the MCP setup form pre-filled from the entry's `configTemplate`
- **AND** SHALL NOT add the server until the user fills the required fields and confirms
- **AND** after the user submits valid values, the server SHALL appear in the "Installed" tab

#### Scenario: user installs skill from market
- **WHEN** user clicks "Install" on a skill in the market
- **THEN** the system SHALL create the skill definition in the skills store from the template
- **AND** the skill SHALL appear in the "Installed" tab
- **AND** the skill SHALL be available for invocation

## ADDED Requirements

### Requirement: Market catalog includes zero-config MCP servers
The bundled market catalog SHALL include at least three MCP servers that require no user-supplied secret or path to connect (derived `requiresConfig === false`): a URL-fetch server, a time/date server, and a demo/test server.

#### Scenario: catalog contains multiple ready-to-use MCP servers
- **WHEN** the market catalog is loaded from the bundled JSON
- **THEN** at least three MCP entries SHALL have `requiresConfig === false`
- **AND** the set SHALL include a fetch server, a time server, and a demo server distinct from `memory` and `sequential-thinking`
