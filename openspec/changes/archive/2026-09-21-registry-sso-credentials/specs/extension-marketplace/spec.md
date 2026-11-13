# extension-marketplace Specification (delta)

## MODIFIED Requirements

### Requirement: One-click install from market

The UI SHALL allow users to install an MCP server or skill from the market. Clicking "Install" on an MCP server SHALL always open the MCP setup form (see the *MCP setup form is generated from config template* requirement in `extension-management-ui`) pre-filled from the catalog template, so the user can confirm or rename before adding. For servers whose `requiresConfig` is `false`, the form has no fillable config fields (only the name), so the Add button is enabled immediately. For servers whose `requiresConfig` is `true`, the form shows labeled fields the user must fill before Add is enabled. Registry-origin entries are credential-shaped instead of token-shaped: their install form SHALL show no fillable credential field when the user holds a live registry credential (see the `registry-credentials` capability), and SHALL route to the connect flow (or manual paste fallback) when they do not.

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

#### Scenario: user installs a registry MCP with a live credential

- **WHEN** a user with a live registry credential clicks "Install" on a registry-origin MCP entry
- **THEN** the setup form SHALL show no fillable credential field and the Add button SHALL be enabled immediately
- **AND** the installed record SHALL reference the registry credential rather than embedding a secret

#### Scenario: user installs a registry MCP without a credential

- **WHEN** a user without a live registry credential clicks "Install" on a registry-origin MCP entry
- **THEN** the UI SHALL offer the connect flow and the manual paste fallback
- **AND** Add SHALL remain disabled until a credential exists

#### Scenario: user installs skill from market

- **WHEN** user clicks "Install" on a skill in the market
- **THEN** the system SHALL create the skill definition in the skills store from the template
- **AND** the skill SHALL appear in the "Installed" tab
