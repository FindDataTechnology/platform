## MODIFIED Requirements

### Requirement: Bots are configured through a management UI and REST API
The server SHALL provide CRUD REST routes for bot configurations (type, name, per-platform credential fields, enabled, persona text, and the per-bot tool switch) with credentials stored server-side only and masked in all API responses, and the web app SHALL provide a bots management surface whose primary entry is the platform icon grid, from which the operator creates, edits, enables/disables, and deletes bots, copies each bot's webhook URL, and opens its onboarding QR panel. The surface SHALL render as a first-class primary-navigation work surface at `/channels` (slug `channels`, nav label 渠道 / Channels), rendered as a member of the 接入 (`access`) nav family alongside 应用 (`apps`) and 智语 (`zhiyu`) — an outbound-communication surface, not configuration — rather than as a section of the Settings modal, and both `/settings/channels` and the legacy `/bots` route SHALL redirect to `/channels` so existing links and bookmarks keep resolving. Configuration changes SHALL take effect without a server restart.

#### Scenario: credential masking
- **WHEN** any bot configuration is read through the API
- **THEN** secret credential values SHALL NOT appear in the response
- **AND** the persona text and the per-bot tool switch SHALL be readable in the response (neither is a secret)

#### Scenario: persona and tool switch round-trip
- **WHEN** the operator saves a persona text and toggles the per-bot tool switch
- **THEN** a subsequent read SHALL return those values, and the next inbound message SHALL run under them without a restart

#### Scenario: disable stops intake
- **WHEN** a bot is disabled
- **THEN** its webhook SHALL reject new messages (404/403) and any polling loop SHALL stop, without affecting the other bots

#### Scenario: bots management is a nav work surface
- **WHEN** the user navigates to `/channels`
- **THEN** the bots management surface SHALL render as a full main-content page outside the Settings modal
- **AND** the 渠道 entry SHALL be the active entry in the 接入 family of the sidebar

#### Scenario: bots management lives in Settings
- **WHEN** the user opens the Settings modal after this change
- **THEN** no 渠道接入 (`channels`) section SHALL be listed
- **AND** the legacy Settings addresses `/settings/channels` and `/bots` SHALL redirect to the `/channels` nav surface, recording the former placement without reviving it

#### Scenario: legacy bot links redirect to the nav surface
- **WHEN** the user navigates to `/bots` or `/settings/channels`
- **THEN** the router SHALL redirect to `/channels`

### Requirement: The bots page presents platforms as an icon grid
The bots management surface (the 渠道 nav surface at `/channels`) SHALL render a grid of the supported chat platforms (Telegram, 飞书, 企业微信, 微信公众号) as tiles carrying a per-platform brand icon and display name (`data-testid="bot-platform-tile"`). Activating a tile SHALL open the add-bot dialog with that platform preselected. Bots already configured SHALL be listed below the grid as cards carrying their platform's brand icon, the enable toggle, edit/delete actions, and the existing webhook URL copy control. Existing bot CRUD, credential masking, and enable/disable behavior SHALL remain unchanged.

#### Scenario: tile opens a typed add dialog
- **WHEN** the user clicks the Telegram tile
- **THEN** the add-bot dialog SHALL open with the type fixed to `telegram` and the Telegram credential fields visible

#### Scenario: configured bot carries its platform icon
- **WHEN** at least one bot is configured
- **THEN** each bot card SHALL show the brand icon of its platform type

#### Scenario: empty state
- **WHEN** no bots are configured
- **THEN** the platform grid SHALL still render and the configured-bots section SHALL show the empty guidance

## ADDED Requirements

### Requirement: The channels slug leaves the Settings container for primary navigation
The `channels` slug SHALL leave the Settings container of the surface registry and join the primary-navigation container (per `layout-configuration`), so that 渠道 is a nav surface governed by layout resolution like every other nav surface: a preset MAY hide it, and the `simple` (non-technical skeleton) preset SHALL exclude it. The move SHALL change placement only — the platform icon grid SHALL remain the primary entry to the surface, configured bots SHALL remain cards with brand icon, enable toggle, edit/delete actions, and webhook URL copy, the onboarding QR panel SHALL remain available, credentials SHALL remain server-side only and masked in responses, the per-bot tool switch SHALL remain, and configuration changes SHALL continue to take effect without a restart.

#### Scenario: bots management lives in Settings
- **WHEN** the user opens the Settings modal after this change
- **THEN** no 渠道接入 (`channels`) section SHALL be listed
- **AND** the legacy Settings addresses `/settings/channels` and `/bots` SHALL redirect to the `/channels` nav surface, recording the former placement without reviving it

#### Scenario: the Settings list no longer carries a channels entry
- **WHEN** the user opens the Settings modal after the move
- **THEN** the Settings section list SHALL NOT contain a 渠道接入 (`channels`) entry
- **AND** the `channels` slug SHALL be present in the primary-navigation container and render as the 渠道 entry of the 接入 family at `/channels`

#### Scenario: a preset may hide the channels entry
- **WHEN** the resolved layout for a user hides `channels`
- **THEN** the 渠道 entry SHALL be absent from the rendered navigation, and the other 接入 members (应用, 智语) SHALL be unaffected

#### Scenario: simple excludes channels
- **WHEN** the `simple` preset resolves for a user
- **THEN** the primary navigation SHALL omit the 渠道 entry, keeping its navigation limited to Chat, Knowledge, Resources, Memory, Agents, and Apps

#### Scenario: placement changes nothing about the bot surface
- **WHEN** the operator opens `/channels`
- **THEN** the platform icon grid SHALL remain the primary entry, with configured bots as cards carrying brand icon, enable toggle, edit/delete actions, and webhook URL copy, and the onboarding QR panel SHALL open as before
- **AND** credentials SHALL remain server-side only and masked in API responses, the per-bot tool switch SHALL remain available, and configuration changes SHALL take effect without a restart
