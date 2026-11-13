## ADDED Requirements

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
The server SHALL provide CRUD REST routes for bot configurations (type, name, per-platform credential fields, enabled) with credentials stored server-side only and masked in all API responses, and the web app SHALL provide a `/bots` page (sidebar-reachable) to create, edit, enable/disable, and delete bots and to copy each bot's webhook URL. Configuration changes SHALL take effect without a server restart.

#### Scenario: credential masking
- **WHEN** any bot configuration is read through the API
- **THEN** secret credential values SHALL NOT appear in the response

#### Scenario: disable stops intake
- **WHEN** a bot is disabled
- **THEN** its webhook SHALL reject new messages (404/403) and any polling loop SHALL stop, without affecting other bots

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
