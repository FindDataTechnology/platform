## MODIFIED Requirements

### Requirement: Bots are configured through a management UI and REST API
The server SHALL provide CRUD REST routes for bot configurations (type, name, per-platform credential fields, enabled) with credentials stored server-side only and masked in all API responses, and the web app SHALL provide a bots management surface whose primary entry is the platform icon grid, from which the operator creates, edits, enables/disables, and deletes bots, copies each bot's webhook URL, and opens its onboarding QR panel. The surface SHALL render as the Settings 渠道接入 (`channels`) section at `/settings/channels` rather than as a sidebar-navigated page, and the legacy `/bots` route SHALL redirect to `/settings/channels` so existing links keep resolving. Configuration changes SHALL take effect without a server restart.

#### Scenario: credential masking
- **WHEN** any bot configuration is read through the API
- **THEN** secret credential values SHALL NOT appear in the response

#### Scenario: disable stops intake
- **WHEN** a bot is disabled
- **THEN** its webhook SHALL reject new messages (404/403) and any polling loop SHALL stop, without affecting the other bots

#### Scenario: bots management lives in Settings
- **WHEN** the user opens Settings and selects the 渠道接入 (channels) section
- **THEN** the bots management surface SHALL render inside the Settings modal
- **AND** navigating to `/bots` SHALL redirect to `/settings/channels`

### Requirement: The bots page presents platforms as an icon grid
The bots management surface (Settings 渠道接入 section) SHALL render a grid of the supported chat platforms (Telegram, 飞书, 企业微信, 微信公众号) as tiles carrying a per-platform brand icon and display name (`data-testid="bot-platform-tile"`). Activating a tile SHALL open the add-bot dialog with that platform preselected. Bots already configured SHALL be listed below the grid as cards carrying their platform's brand icon, the enable toggle, edit/delete actions, and the existing webhook URL copy control. Existing bot CRUD, credential masking, and enable/disable behavior SHALL remain unchanged.

#### Scenario: tile opens a typed add dialog
- **WHEN** the user clicks the Telegram tile
- **THEN** the add-bot dialog SHALL open with the type fixed to `telegram` and the Telegram credential fields visible

#### Scenario: configured bot carries its platform icon
- **WHEN** at least one bot is configured
- **THEN** each bot card SHALL show the brand icon of its platform type

#### Scenario: empty state
- **WHEN** no bots are configured
- **THEN** the platform grid SHALL still render and the configured-bots section SHALL show the empty guidance
