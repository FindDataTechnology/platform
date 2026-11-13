## ADDED Requirements

### Requirement: Market catalog is browsable
The UI SHALL present a market tab displaying a curated catalog of MCP servers and skills, organized by category (e.g., productivity, development, data, communication).

#### Scenario: user browses market catalog
- **WHEN** user navigates to the market tab
- **THEN** the UI SHALL display a list of available MCP servers and skills
- **AND** each item SHALL show name, description, category, and an "Install" button
- **AND** items SHALL be filterable by category

#### Scenario: user searches market
- **WHEN** user types in a search box
- **THEN** the UI SHALL filter the catalog to items matching the search query

### Requirement: One-click install from market
The UI SHALL allow users to install an MCP server or skill from the market with a single action, automatically generating the configuration entry.

#### Scenario: user installs MCP server from market
- **WHEN** user clicks "Install" on an MCP server in the market
- **THEN** the system SHALL add the server configuration to the MCP config store
- **AND** the server SHALL appear in the "Installed" tab
- **AND** the server SHALL be connected and its tools registered

#### Scenario: user installs skill from market
- **WHEN** user clicks "Install" on a skill in the market
- **THEN** the system SHALL create the skill definition in the skills store
- **AND** the skill SHALL appear in the "Installed" tab
- **AND** the skill SHALL be available for invocation

### Requirement: Market catalog is sourced from static JSON or remote registry
The market catalog SHALL be loaded from a bundled JSON file shipped with the application, or optionally fetched from a remote registry URL if configured.

#### Scenario: bundled market catalog
- **WHEN** no remote registry URL is configured
- **THEN** the market SHALL load from `resources/market-catalog.json` bundled with the app

#### Scenario: remote market catalog
- **WHEN** a remote registry URL is configured via env var
- **THEN** the market SHALL fetch the catalog from that URL
- **AND** fall back to the bundled catalog if the fetch fails
