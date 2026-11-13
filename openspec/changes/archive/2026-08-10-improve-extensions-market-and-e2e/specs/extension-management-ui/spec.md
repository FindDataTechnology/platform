## ADDED Requirements

### Requirement: MCP setup form is generated from config template
When the user installs an MCP server from the market whose `requiresConfig` is `true`, the add-server form SHALL render in a setup mode generated from the entry's `configTemplate`, rather than pre-filling the raw manual-add fields with placeholder strings. The form SHALL be data-driven from the template — one labeled field per `configTemplate.env` key and one labeled field per placeholder argument — not hardcoded per server.

#### Scenario: setup form renders a field per env key
- **WHEN** the user clicks "Install" on a needs-config MCP server whose template has `env: { GITHUB_PERSONAL_ACCESS_TOKEN: "your_token_here" }`
- **THEN** the form SHALL render a labeled text input whose label is the env key `GITHUB_PERSONAL_ACCESS_TOKEN`
- **AND** the input SHALL be empty with the template's placeholder value as a hint
- **AND** the template's `installInstructions` SHALL be shown as help text

#### Scenario: setup form renders a field per placeholder argument
- **WHEN** the user clicks "Install" on a needs-config MCP server whose template has `args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/directory"]`
- **THEN** the form SHALL render a labeled text input for the `/path/to/allowed/directory` argument
- **AND** the literal arguments `-y` and `@modelcontextprotocol/server-filesystem` SHALL be shown as read-only, non-editable values

#### Scenario: Add is disabled until required fields are filled
- **WHEN** the setup form is open and one or more placeholder fields are empty
- **THEN** the Add button SHALL be disabled
- **WHEN** the user fills every placeholder field with a non-empty value
- **THEN** the Add button SHALL become enabled

#### Scenario: submitted config is reconstructed from field values
- **WHEN** the user fills the setup form fields and clicks Add
- **THEN** the system SHALL reconstruct the server config by preserving template literal arguments in order and substituting the filled values into placeholder positions
- **AND** the `env` object SHALL contain only the filled env-key values
- **AND** the server SHALL be added with the reconstructed config and appear in the Installed tab

#### Scenario: manual add and edit keep the raw form
- **WHEN** the user clicks "Add MCP" without a market template, or clicks "Edit" on an existing server
- **THEN** the form SHALL render the raw manual-add fields (command, args, env JSON, url, headers JSON) as before
- **AND** the setup-mode fields SHALL NOT be rendered
