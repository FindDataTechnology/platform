## ADDED Requirements

### Requirement: The bots page presents platforms as an icon grid

The `/bots` page SHALL render a grid of the supported chat platforms
(Telegram, 飞书, 企业微信, 微信公众号) as tiles carrying a per-platform brand
icon and display name (`data-testid="bot-platform-tile"`). Activating a tile
SHALL open the add-bot dialog with that platform preselected. Bots already
configured SHALL be listed below the grid as cards carrying their platform's
brand icon, the enable toggle, edit/delete actions, and the existing webhook
URL copy control. Existing bot CRUD, credential masking, and enable/disable
behavior SHALL remain unchanged.

#### Scenario: tile opens a typed add dialog
- **WHEN** the user clicks the Telegram tile
- **THEN** the add-bot dialog SHALL open with the type fixed to `telegram` and
  the Telegram credential fields visible

#### Scenario: configured bot carries its platform icon
- **WHEN** at least one bot is configured
- **THEN** each bot card SHALL show the brand icon of its platform type

#### Scenario: empty state
- **WHEN** no bots are configured
- **THEN** the platform grid SHALL still render and the configured-bots
  section SHALL show the empty guidance

### Requirement: A bot dialog shows an onboarding QR for end users

A saved bot's edit dialog SHALL provide a QR section
(`data-testid="bot-qr-panel"`) presenting a scannable code plus the resolved
target URL and short per-platform setup steps. Resolution SHALL happen
server-side and SHALL follow the platform's declared strategy: Telegram —
resolve the bot username through the `getMe` API using the stored token and
encode `https://t.me/<username>`; 微信公众号 — request a permanent QR through
the platform `qrcode/create` API with stored credentials; 飞书 / 企业微信 —
encode an operator-provided user-entry URL (`qrUrl` credential field,
non-secret). The QR image SHALL be generated server-side (SVG) so the browser
needs no QR library and no secret value.

#### Scenario: Telegram QR resolved server-side
- **WHEN** the QR panel opens for a Telegram bot with a valid token
- **THEN** the server SHALL call `getMe`, return the `https://t.me/<username>`
  URL and an SVG QR encoding it, and the token SHALL NOT appear in any
  response to the browser

#### Scenario: manual-link platforms
- **WHEN** the QR panel opens for a 飞书 or 企业微信 bot with `qrUrl`
  configured
- **THEN** the server SHALL render that URL as an SVG QR
- **AND** when `qrUrl` is absent the panel SHALL prompt for the link instead
  of failing the dialog

#### Scenario: upstream resolution fails
- **WHEN** the platform API rejects the credentials or the account type does
  not support QR creation
- **THEN** the server SHALL answer with a failure state carrying the platform
  message, and the panel SHALL show that reason plus the manual-link fallback
  while leaving bot CRUD and the rest of the dialog functional

### Requirement: QR resolution endpoint

The server SHALL expose `GET /api/bots/:id/qr` returning
`{ strategy, url|null, qr|null, hint, error? }` for a configured bot. The
endpoint SHALL sit behind the same auth posture as other bot management
routes, SHALL use server-held credentials only, and SHALL NOT log request
bodies. Under `AUTH_MODE=forward_auth` it remains behind the proxy like the
rest of bot management (it is not a platform-facing webhook).

#### Scenario: unknown bot
- **WHEN** the id does not exist
- **THEN** the server SHALL answer 404

#### Scenario: disabled bot
- **WHEN** the bot is disabled
- **THEN** its QR SHALL still resolve (the QR advertises an entry the
  operator may be preparing), with no status side effects

## MODIFIED Requirements

### Requirement: Bots are configured through a management UI and REST API

The server SHALL provide CRUD REST routes for bot configurations (type, name,
per-platform credential fields, enabled) with credentials stored server-side
only and masked in all API responses, and the web app SHALL provide a `/bots`
page whose primary entry is the platform icon grid, from which the operator
creates, edits, enables/disables, and deletes bots, copies each bot's webhook
URL, and opens its onboarding QR panel. Configuration changes SHALL take
effect without a server restart.

#### Scenario: credential masking
- **WHEN** any bot configuration is read through the API
- **THEN** secret credential values SHALL NOT appear in the response

#### Scenario: disable stops intake
- **WHEN** a bot is disabled
- **THEN** its webhook SHALL reject new messages (404/403) and any polling loop SHALL stop, without affecting the other bots
