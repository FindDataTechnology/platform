# social-bot-channels Specification

## Purpose
The inbound and outbound bridge between external chat platforms (企业微信 self-built apps, 飞书 custom apps, Telegram, 微信公众号) and the platform's agent: verified platform messages run agent turns on per-(bot, chat) persistent sessions under untrusted-input guards, bots are administered through an admin REST/UI surface, and each chat that messages a bot is recorded server-side so it can be addressed later — including through the machine-caller relay (see `bot-relay`).

## Requirements
### Requirement: The server accepts inbound bot messages from configured chat platforms
The server SHALL expose per-bot webhook endpoints (`/api/bots/webhook/:botId/:secret`) for 企业微信 (WeCom self-built app), 飞书 (Feishu custom app), Telegram, and 微信公众号 (WeChat official account), each authenticating the request via the platform's own verification mechanism (signature check or payload decryption) plus a per-bot secret in the path BEFORE any payload content reaches the agent. Unauthenticated or unverified requests SHALL be rejected with 403 and their content SHALL NOT be logged.

#### Scenario: platform URL verification handshake
- **WHEN** a platform sends its verification request (WeCom echo, Feishu challenge, WeChat echostr) to a configured bot's webhook
- **THEN** the server SHALL reply with the platform-required literal response

#### Scenario: forged request rejected
- **WHEN** a request reaches a bot webhook with an invalid secret, signature, or undecryptable payload
- **THEN** the server SHALL return 403 without processing or logging the content

#### Scenario: inbound message round-trip
- **WHEN** a verified text message arrives from an external chat
- **THEN** the server SHALL run one agent turn on the session bound to that (bot, chat) pair and deliver the assistant's final text back to the originating chat via the platform's send API

### Requirement: Each external chat maps to its own persistent agent session
The server SHALL derive a stable session id per (bot, external chat id) pair, independent of the web chat session, and SHALL resume that conversation across runtime restarts via dsh's session persistence. Concurrent turns from different chats SHALL run in parallel; turns within one chat SHALL be serialized in arrival order.

#### Scenario: conversation continuity
- **WHEN** the same external chat sends messages across a server or runtime restart
- **THEN** the agent's conversation history for that chat SHALL persist

#### Scenario: web chat unaffected
- **WHEN** a bot turn is streaming
- **THEN** web-chat WebSocket events SHALL reflect only web-session events (no cross-session leakage)

### Requirement: Bot messages are untrusted input with bounded agent exposure
The inbound pipeline SHALL enforce a message length cap and a per-chat rate limit before prompting the agent, and SHALL disable agent tools for bot sessions unless `BOTS_ALLOW_TOOLS` is explicitly enabled. Replies SHALL contain the assistant's final text only.

#### Scenario: tool posture default
- **WHEN** a bot message triggers a turn and `BOTS_ALLOW_TOOLS` is unset
- **THEN** the turn SHALL run without tool execution

#### Scenario: rate limit
- **WHEN** a chat exceeds the per-chat message rate limit
- **THEN** excess messages SHALL be dropped with a log entry (no agent turn)

### Requirement: Bots are configured through a management UI and REST API
The server SHALL provide CRUD REST routes for bot configurations (type, name, per-platform credential fields, enabled) with credentials stored server-side only and masked in all API responses, and the web app SHALL provide a `/bots` page whose primary entry is the platform icon grid, from which the operator creates, edits, enables/disables, and deletes bots, copies each bot's webhook URL, and opens its onboarding QR panel. Configuration changes SHALL take effect without a server restart.

#### Scenario: credential masking
- **WHEN** any bot configuration is read through the API
- **THEN** secret credential values SHALL NOT appear in the response

#### Scenario: disable stops intake
- **WHEN** a bot is disabled
- **THEN** its webhook SHALL reject new messages (404/403) and any polling loop SHALL stop, without affecting the other bots

### Requirement: The bots page presents platforms as an icon grid
The `/bots` page SHALL render a grid of the supported chat platforms (Telegram, 飞书, 企业微信, 微信公众号) as tiles carrying a per-platform brand icon and display name (`data-testid="bot-platform-tile"`). Activating a tile SHALL open the add-bot dialog with that platform preselected. Bots already configured SHALL be listed below the grid as cards carrying their platform's brand icon, the enable toggle, edit/delete actions, and the existing webhook URL copy control. Existing bot CRUD, credential masking, and enable/disable behavior SHALL remain unchanged.

#### Scenario: tile opens a typed add dialog
- **WHEN** the user clicks the Telegram tile
- **THEN** the add-bot dialog SHALL open with the type fixed to `telegram` and the Telegram credential fields visible

#### Scenario: configured bot carries its platform icon
- **WHEN** at least one bot is configured
- **THEN** each bot card SHALL show the brand icon of its platform type

#### Scenario: empty state
- **WHEN** no bots are configured
- **THEN** the platform grid SHALL still render and the configured-bots section SHALL show the empty guidance

### Requirement: A bot dialog shows an onboarding QR for end users
A saved bot's edit dialog SHALL provide a QR section (`data-testid="bot-qr-panel"`) presenting a scannable code plus the resolved target URL and short per-platform setup steps. Resolution SHALL happen server-side and SHALL follow the platform's declared strategy: Telegram — resolve the bot username through the `getMe` API using the stored token and encode `https://t.me/<username>`; 微信公众号 — request a permanent QR through the platform `qrcode/create` API with stored credentials; 飞书 / 企业微信 — encode an operator-provided user-entry URL (`qrUrl` credential field, non-secret). The QR image SHALL be generated server-side (SVG) so the browser needs no QR library and no secret value.

#### Scenario: Telegram QR resolved server-side
- **WHEN** the QR panel opens for a Telegram bot with a valid token
- **THEN** the server SHALL call `getMe`, return the `https://t.me/<username>` URL and an SVG QR encoding it, and the token SHALL NOT appear in any response to the browser

#### Scenario: manual-link platforms
- **WHEN** the QR panel opens for a 飞书 or 企业微信 bot with `qrUrl` configured
- **THEN** the server SHALL render that URL as an SVG QR
- **AND** when `qrUrl` is absent the panel SHALL prompt for the link instead of failing the dialog

#### Scenario: upstream resolution fails
- **WHEN** the platform API rejects the credentials or the account type does not support QR creation
- **THEN** the server SHALL answer with a failure state carrying the platform message, and the panel SHALL show that reason plus the manual-link fallback while leaving bot CRUD and the rest of the dialog functional

### Requirement: QR resolution endpoint
The server SHALL expose `GET /api/bots/:id/qr` returning `{ strategy, url|null, qr|null, hint, error? }` for a configured bot. The endpoint SHALL sit behind the same auth posture as other bot management routes, SHALL use server-held credentials only, and SHALL NOT log request bodies. Under `AUTH_MODE=forward_auth` it remains behind the proxy like the rest of bot management (it is not a platform-facing webhook).

#### Scenario: unknown bot
- **WHEN** the id does not exist
- **THEN** the server SHALL answer 404

#### Scenario: disabled bot
- **WHEN** the bot is disabled
- **THEN** its QR SHALL still resolve (the QR advertises an entry the operator may be preparing), with no status side effects

### Requirement: Proactive outbound send
The server SHALL provide an admin-gated `POST /api/bots/:id/send` endpoint delivering text to a previously-seen chat key via the platform's send API, for use by cron jobs and integrations.

#### Scenario: proactive push
- **WHEN** an authenticated admin POSTs `{ chatKey, text }`
- **THEN** the message SHALL be delivered through the bot's platform send API

### Requirement: Webhook authentication under forward auth
When `AUTH_MODE=forward_auth` is active, bot webhook routes SHALL be exempt from the proxy-injected identity header requirement (external platforms cannot supply it) and SHALL rely exclusively on their platform verification; all other bot management routes SHALL remain behind the proxy as usual.

#### Scenario: webhook reachable by platform under forward auth
- **WHEN** the server runs with forward_auth enabled and a platform sends a signed webhook request
- **THEN** the request SHALL be processed on platform verification alone

### Requirement: Bot module degrades gracefully
The bots module SHALL be inert when no bots are configured, and a failing or misconfigured bot SHALL be logged and isolated without preventing the server, other bots, or the web chat from operating.

#### Scenario: bad credentials do not crash the server
- **WHEN** a bot's send API rejects its credentials during a reply
- **THEN** the failure SHALL be logged, the chat's user notified of the error where possible, and the server SHALL continue serving

### Requirement: Inbound bot messages record their chat for later addressing
The server SHALL record the chat of every verified inbound bot message — bot id, chat key, sender display name, and first/last-seen timestamps — upserting one row per (bot, chat key), so previously-seen chats are enumerable for administrative channel binding. The record SHALL NOT contain message content. A recording failure SHALL be logged and SHALL NOT block the agent turn or the reply.

#### Scenario: first message from a chat is recorded
- **WHEN** a verified inbound message arrives from a chat not seen before
- **THEN** a row for that (bot, chat key) is created carrying the sender display name and the first-seen timestamp

#### Scenario: repeat messages update, never duplicate
- **WHEN** further messages arrive from a recorded chat
- **THEN** the existing row's last-seen timestamp is updated and no duplicate row is created

#### Scenario: content is not stored
- **WHEN** any inbound message is recorded
- **THEN** only identity and timing fields are stored, never the message text

#### Scenario: recording failure does not affect the conversation
- **WHEN** recording the chat fails
- **THEN** the failure is logged and the agent turn and its reply proceed normally
