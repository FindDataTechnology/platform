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

### Requirement: A pending bot ask renders as numbered-option text

WHEN an ask is pending in a bot chat, the bot SHALL deliver the question batch to the chat as text: each question with its options numbered, guidance to reply with a number or an option's exact wording, and — for multi-select questions — a note that several numbers may be replied comma-separated. A question with no options SHALL be asked as a plain free-text question whose next reply becomes the custom answer.

#### Scenario: options question renders with numbers

- **WHEN** an ask with options becomes pending in a bot chat
- **THEN** the chat receives the question as text with numbered options and reply guidance

#### Scenario: free-text question asks plainly

- **WHEN** an ask with no options becomes pending in a bot chat
- **THEN** the chat receives the question as text and the next reply is treated as the custom answer

### Requirement: The next inbound message answers the pending ask instead of starting a turn

WHILE an ask is pending in a bot chat, the next inbound message SHALL be intercepted as an answer attempt and SHALL NOT queue a new agent turn. A reply matching a number or an option's exact wording SHALL select that option; a multi-select reply of several numbers SHALL select each; any other text SHALL be submitted as the custom answer for free-text-accepting questions, otherwise the bot SHALL re-prompt with the options again — after three failed attempts the ask SHALL be cancelled automatically. Existing inbound guards (size, rate) apply unchanged before interception.

#### Scenario: a number selects its option

- **WHEN** the user replies "2" to a pending numbered question
- **THEN** the second option is submitted as the answer and no new turn starts

#### Scenario: plain text becomes a custom answer

- **WHEN** the user replies free text to a question accepting custom answers
- **THEN** the text is submitted as the custom answer

#### Scenario: three failed attempts cancel the ask

- **WHEN** three consecutive replies match no option of a question that accepts no custom answer
- **THEN** the ask is cancelled automatically and the model continues with a cancelled result

### Requirement: The ask wait window bounds waiting and pauses the turn timeout

A bot ask SHALL wait at most a configurable window (default 10 minutes) for the user's reply; while the ask is pending, the turn hard timeout SHALL be paused, and on window expiry the ask SHALL be cancelled automatically with the turn continuing to its normal conclusion.

#### Scenario: window expiry cancels the ask

- **WHEN** the wait window elapses with no reply
- **THEN** the ask is cancelled, the model receives a cancelled result, and the turn concludes normally

#### Scenario: turn timeout does not fire while waiting

- **WHEN** an ask has been pending longer than the turn hard timeout
- **THEN** the turn is not failed while the ask is pending

### Requirement: The answer-only posture exempts the ask tool

UNDER the default no-tools posture, `ask_user_question` SHALL remain callable in bot sessions, and a turn whose reply incorporates the user's answer to an ask SHALL NOT be withheld as tool-derived.

#### Scenario: an ask works under the default posture

- **WHEN** the agent asks and the user answers under the default no-tools posture
- **THEN** the ask is delivered, the answer resolves it, and the final reply is delivered to the chat

### Requirement: The multi-tenant gateway routes machine webhooks to the owning cell

On a gateway-fronted multi-tenant deployment, a chat platform's webhook call carries no platform identity; the gateway SHALL route `/api/bots/webhook/<botId>/<secret>` to the cell owning that bot (booting it if stopped) instead of rejecting it as unauthenticated. The webhook's authentication remains the per-bot path secret plus the platform's own signature, verified inside the cell.

#### Scenario: the WeChat handshake passes through the gateway

- **WHEN** WeChat's URL-verification GET (signed with the bot's callback token) arrives at the public webhook URL
- **THEN** the gateway forwards it to the owning cell and the caller receives the echostr verbatim, without any platform session

#### Scenario: an unknown bot is not routed

- **WHEN** the webhook path names a bot id no cell owns
- **THEN** the gateway answers 404 and no cell is started
