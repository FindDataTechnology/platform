# bot-relay Specification (delta)

## Purpose

Lets machine callers outside a browser session — cloud-hosted MCP services on an operator-trusted network — deliver text through the configured chat-platform bots, addressing pre-authorized named channels instead of raw platform chat keys.

## ADDED Requirements

### Requirement: The relay endpoint carries its own machine authentication

The server SHALL expose `POST /api/bots/relay/send` accepting `{ channel, text }`, authenticated exclusively by a deployment-injected bearer token compared in constant time. The route SHALL be exempt from interactive proxy/logto identity (a machine caller cannot supply a browser session) and SHALL rely on that token alone. Token verification SHALL happen before the payload is parsed, used, or logged, and a request with a missing or incorrect token SHALL be rejected with 401 without recording its content. When no token is configured, the route SHALL be inert — it SHALL NOT exist in a less-protected form. The token value SHALL NOT appear in any response, log line, or error message.

#### Scenario: a valid token delivers the text

- **WHEN** a caller posts `{ channel, text }` with the configured token
- **THEN** the server delivers the text through that channel's bot and answers success

#### Scenario: forged request is rejected without recording content

- **WHEN** a request arrives with a missing or incorrect token
- **THEN** the server answers 401 and the request body is not processed or logged

#### Scenario: unconfigured relay is inert

- **WHEN** no relay token is configured on the deployment
- **THEN** the relay route answers 404 and no send path is reachable without authentication

### Requirement: Callers address named channels, never raw destinations

Delivery SHALL target only destinations an administrator has pre-bound: a channel name resolves to exactly one (bot, chat key) pair. The caller SHALL NOT be able to influence the destination — a bot id or chat key supplied alongside the channel SHALL have no effect. An unknown channel SHALL be rejected with 404 and no send attempted. A channel whose bot is disabled SHALL be refused without sending.

#### Scenario: channel name is the only destination input

- **WHEN** a caller posts a channel name together with extra bot or chat-key fields
- **THEN** the text is delivered to the channel's pre-bound destination and the extra fields are ignored

#### Scenario: unknown channel

- **WHEN** the channel name matches no binding
- **THEN** the server answers 404 and no platform API call is made

#### Scenario: disabled bot refuses delivery

- **WHEN** the channel's bound bot is disabled
- **THEN** the server refuses the send without contacting the platform

### Requirement: Channel bindings are administratively managed

The server SHALL provide admin-gated REST routes to list, create, and delete channel bindings. A binding SHALL be creatable only for a chat key previously recorded from a verified inbound message (no free-form destination entry), channel names SHALL be unique, and deletion SHALL take effect for subsequent sends immediately. Listing SHALL expose channel name, bot, chat key, and creation time, and SHALL NOT expose bot credentials.

#### Scenario: bind a recorded chat

- **WHEN** an admin creates a channel for a (bot, chat key) pair present in the recorded chats
- **THEN** the binding is stored and the relay can address it immediately

#### Scenario: unrecorded destination cannot be bound

- **WHEN** an admin attempts to bind a (bot, chat key) pair never seen inbound
- **THEN** the server rejects the request and no binding is created

#### Scenario: deletion stops delivery

- **WHEN** a binding is deleted
- **THEN** a relay send to that channel answers 404 while other channels keep working

### Requirement: Outbound sends are bounded and recorded

Before contacting any platform the relay SHALL enforce a per-channel rate limit and a maximum text length, mirroring the inbound pipeline's guards. Every send attempt SHALL be recorded server-side with its channel, bot, outcome, and the text length only — the message text itself SHALL NOT be stored. A platform send failure SHALL be reported to the caller and recorded, and SHALL NOT affect the server, other channels, or the web chat.

#### Scenario: rate limit

- **WHEN** a channel exceeds its per-minute send allowance
- **THEN** the excess request is rejected with 429, is recorded, and no platform API call is made

#### Scenario: oversize text rejected

- **WHEN** the text exceeds the maximum length
- **THEN** the server rejects the request without sending and records the rejection

#### Scenario: platform failure is contained

- **WHEN** the platform's send API rejects the call
- **THEN** the caller receives an error naming the failure, the attempt is recorded, and the server keeps serving

#### Scenario: no message content is persisted

- **WHEN** any send is recorded
- **THEN** the stored record contains the channel, bot, outcome, and text length, and never the text

### Requirement: Delivery reuses the single outbound send path

The relay SHALL deliver through the same per-platform send mechanism as bot replies, inside the server process, so credentials, platform access-token caching, and any polling loop keep exactly one owner. Introducing the relay SHALL NOT start a second poller or a second token cache for any bot.

#### Scenario: no second poller or token owner

- **WHEN** a relay send occurs while a bot's inbound receiving is active
- **THEN** no additional polling loop or platform token cache is created by the relay path
