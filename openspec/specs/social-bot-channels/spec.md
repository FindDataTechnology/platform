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
The inbound pipeline SHALL enforce a message length cap and a per-chat rate limit before prompting the agent. Agent tools SHALL be disabled for bot sessions by default: a bot MAY run tools only when BOTH the bot's own `allow_tools` setting is enabled AND the deployment-level `BOTS_ALLOW_TOOLS` ceiling is enabled. Replies SHALL contain the assistant's final text only.

#### Scenario: tool posture default
- **WHEN** a bot message triggers a turn and that bot's `allow_tools` is off (or unset)
- **THEN** the turn SHALL run without tool execution, and a reply derived from tool calls SHALL be withheld

#### Scenario: per-bot enable under the deployment ceiling
- **WHEN** the bot's `allow_tools` is enabled AND the deployment ceiling `BOTS_ALLOW_TOOLS` is enabled
- **THEN** the turn MAY run tools and its answer SHALL be forwarded

#### Scenario: deployment ceiling wins
- **WHEN** the bot's `allow_tools` is enabled but the deployment ceiling `BOTS_ALLOW_TOOLS` is unset or disabled
- **THEN** the turn SHALL run without tool execution (the ceiling cannot be lifted per bot)

#### Scenario: rate limit
- **WHEN** a chat exceeds the per-chat message rate limit
- **THEN** excess messages SHALL be dropped with a log entry (no agent turn)

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

### Requirement: 可选的房间桥接路由

当 bot 行携带 `zhiRoomId` 时，webhook 入站路径 SHALL 送到 IM 群桥（add-zhiyu-im-bridge）：该 bot 的群消息不再在本 cell 起 agent 会话、而是以人类消息落到绑定房间；当该字段为空时一切行为与桥出现前逐字节一致。桥互相的 Channel/Secret 验证与内容搬迁将已照旧进行，不做任何谓词改变。

#### Scenario: 绑定 bot 的群消息走桥径

- **WHEN** 一个绑定了房间的 bot 收到一条通过验签的群消息
- **THEN** 消息送到桥径（进房间），本 cell 不起该群的新会话

#### Scenario: 未绑定者是逐字节旧行为

- **WHEN** 一个没有 `zhiRoomId` 的 bot 收到同形群消息
- **THEN** 与桥出现前完全一致的行为、无分支

### Requirement: 企业微信智能机器人作为独立类型接入，群聊与单聊分流

系统 SHALL 把企业微信「智能机器人」作为一个与现有自建应用（`wecom`）并列的独立 bot 类型接入，两者共用同一套加解密与签名校验实现，但按回调报文中的会话类型分流：

- 群聊会话（`group`）：会话标识 SHALL 取该群的会话 id（`chatid`），即**一个群对应一个连续会话**，与群里是谁发言无关。
- 单聊会话（`single`）：会话标识 SHALL 取成员标识，与该成员单独对话的历史连续。
- 群聊中平台只在成员 @机器人 时回调；未被提及的群消息平台不会送达，系统 SHALL NOT 试图订阅或读取整群消息。
- 群聊回复 SHALL 走机器人回复通道；单聊回复 SHALL 沿用自建应用的成员单发通道。

#### Scenario: 群里 @ 机器人得到答复
- **WHEN** 群成员在群里 @机器人 并提问，平台回调该机器人的 webhook
- **THEN** 系统 SHALL 在该群对应的会话上跑一个回合，并把助手最终文本回复到同一个群

#### Scenario: 同一群的不同成员共享一个会话
- **WHEN** 群成员 A 先在群里 @机器人 提问，随后成员 B 在同一群 @机器人 追问
- **THEN** 两次提问 SHALL 落在同一个会话历史上，助手能引用 A 的问题回答 B

#### Scenario: 群聊与单聊互不串台
- **WHEN** 同一个成员既私聊机器人、又在群里 @机器人
- **THEN** 两条对话 SHALL 分别落在各自的会话上，回复只回到发起那一侧

#### Scenario: 未被提及的群消息不产生任何行为
- **WHEN** 群成员在群里正常聊天而没有 @机器人
- **THEN** 系统 SHALL NOT 收到、记录或回应任何该类消息

### Requirement: 群聊正文剥离提及标记后进入 agent

群聊回调的正文 SHALL 去掉平台附加的 @提及标记（包含 @机器人 本身及前导空白）后再作为用户问题交给 agent，避免提及标记污染问题语义或出现在助手输出的引用里。

#### Scenario: 提及标记不进入问题正文
- **WHEN** 群成员发送「@智语 帮我看下这份合同的付款条款」
- **THEN** agent 收到的问题 SHALL 等价于「帮我看下这份合同的付款条款」

#### Scenario: 只 @ 不说话
- **WHEN** 群成员只发了一个 @机器人 而没有实际内容
- **THEN** 系统 SHALL 视为空消息丢弃，SHALL NOT 起回合

### Requirement: 群聊沿用 bot 车道的全部输入守卫与隐私边界

群聊消息 SHALL 与单聊同等遵守既有的不可信输入约束：长度上限、按会话的限流、未开启工具姿态时禁止工具执行、回复仅含助手最终文本（不含推理痕迹）、待答问询的拦截与超时窗口。群聊可见面更广，因此上述约束 SHALL NOT 因会话类型为群聊而被放宽。

#### Scenario: 群聊不享受守卫豁免
- **WHEN** 群聊消息超过长度上限或在限流窗口内超频
- **THEN** 系统 SHALL 与单聊一致地丢弃并留日志，不因"在群里"而放行

#### Scenario: 推理痕迹不得发到群里
- **WHEN** 模型把推理痕迹折进了正文
- **THEN** 发往群聊的内容 SHALL 已剥离该痕迹，剥空则回诚实兜底话术

### Requirement: 回复成功必须留下可判读的痕迹

系统 SHALL 在每次回复成功送达聊天平台后记录一条可判读的日志（bot 名、会话标识、回复开头）。仅有失败才留痕是不可接受的：那会让「回复已送达」与「回合根本没跑」在运行日志上不可区分。

#### Scenario: 成功送达留痕
- **WHEN** 一次 bot 回合的回复被平台接受
- **THEN** 日志 SHALL 出现一条该次回复的记录，含 bot 名与会话标识

#### Scenario: 失败与成功可区分
- **WHEN** 运维排查"用户说没收到回复"
- **THEN** 通过日志 SHALL 能区分「已回复」「回复失败」「回合未运行」三种情形

### Requirement: 冷启动窗口内的 webhook 不得以确定拒绝丢弃消息

当 bot 注册表尚未装载完成（服务已开始监听、但配置尚未加载）时，webhook SHALL NOT 以确定拒绝（如 4xx）回应聊天平台——平台会把确定拒绝视为终局从而永久丢弃该消息。系统 SHALL 先接受该请求（回平台期望的成功应答），在注册表就绪后按**完整原有管线**处理（含签名校验与内容解析），缓冲 SHALL 有界；超过上限 SHALL 显式拒绝而非静默堆积。启动完成后，未知 bot 仍 SHALL 得到与原先一致的拒绝，不得因此泄露 bot 是否存在。

#### Scenario: 冷启动期间到达的消息不丢
- **WHEN** 服务已监听但 bot 配置尚未加载完成时，平台投递一条已签名消息
- **THEN** 系统 SHALL 立即以成功应答回应，并在配置加载完成后处理该消息（含校验）并产生回合

#### Scenario: 缓冲有界
- **WHEN** 配置加载迟迟未完成且缓冲已满
- **THEN** 系统 SHALL 以可重试的错误应答回应并留日志，而不是无界堆积

#### Scenario: 未知 bot 的拒绝语义不变
- **WHEN** 配置加载完成后，一条消息指向不存在的 bot
- **THEN** 系统 SHALL 返回与修复前一致的拒绝，且不透露该 bot 是否存在

### Requirement: 回调受理持久化先于处理

外部平台 webhook 验签通过后，服务端 SHALL 先把受理项（含原始载荷与 bot 标识）持久化落盘，
持久化成功后方才应答平台，处理（agent 回合与回信）SHALL 异步进行。启动窗缓冲 SHALL 与该受理
队列同一盘上机制（容量上限触发时 SHALL 落盘排队而非丢弃，超限退化为显式 503 并留痕）。进程
重启后，重启前已持久化但未处理完成的受理项 SHALL 被接管补处理，补处理结果与首处理无异。

#### Scenario: 死窗后重启接管补处理

- **WHEN** 一次滚版前有回调已持久化、其处理未完成，进程随后重启
- **THEN** 重启后该受理项被接管并完成处理（agent 回合照跑、回信照发），不要求外部平台重发

#### Scenario: 受理上限落盘不丢弃

- **WHEN** 启动窗或处理积压使待处理受理超过内存上限
- **THEN** 超出部分仍在盘上排队等待处理，仅当盘上队列超限时才显式拒绝并记录

### Requirement: 平台消息幂等重放安全

服务端 SHALL 以平台消息标识（企微 MsgId 等，各适配器解析面已有者）为幂等键去重：同一 bot 的
同一消息标识重复到达（上游重试、边缘重放、受理补处理与首处理重叠）MUST NOT 产生第二次
agent 回合或第二次回信。幂等键 SHALL 与受理队列同生命周期保留（覆盖受理补处理窗口），无法
解析出消息标识的载荷 SHALL 按原行为处理（不猜键、不虚构去重）。

#### Scenario: 重复投递不二跑

- **WHEN** 同一平台消息（相同消息标识）在同一 bot 上第二次到达（重试或重放）
- **THEN** 服务端幂等确认后不再触发 agent 回合，不重复回信，并以可观测方式记录一次重复受理

#### Scenario: 无标识载荷不虚构键

- **WHEN** 到达载荷不含可解析的平台消息标识
- **THEN** 该载荷按既有行为正常受理处理，幂等层不得对其猜造键或误判重复

### Requirement: 运行时就绪前的入站消息排队而非以兜底文案回复
当 bot 注册表已装载、但 agent 运行时尚未就绪时，系统 SHALL 在预算内等待运行时就绪并照常完成回合，而不是立刻以「正在启动」之类的兜底文案回复。等待 SHALL 有界；超时后 SHALL 回复兜底文案并留下可判读日志，标明是「等待超时」而非「回合失败」。等待期间同一会话的后续入站消息 SHALL 串行排队：既不并发进入运行时，也不丢失。

#### Scenario: 预算内就绪则照常作答
- **WHEN** 一条消息到达时运行时尚未就绪，且运行时在等待预算内变为就绪
- **THEN** 该回合 SHALL 正常执行并回复真实答案，且 SHALL NOT 出现「正在启动」类兜底文案

#### Scenario: 等待预算耗尽
- **WHEN** 等待超过预算后运行时仍未就绪
- **THEN** 系统 SHALL 回复兜底文案，并留下一条标明「等待超时」的日志

#### Scenario: 等待期间同会话串行
- **WHEN** 等待期间同一会话又到达一条消息
- **THEN** 第二条 SHALL 在第一条回合结束后处理，SHALL NOT 并发执行，也 SHALL NOT 被丢弃

### Requirement: bot 回合携带身份注入
每个 bot 回合 SHALL 在提示词中携带该 bot 的身份块。配置了人格的 bot 使用其人格文本；未配置的使用中性默认——声明它是该 bot 名对应的对外助手、只用自身知识作答、不得冒充运营者、舰队副驾或其他内部角色。身份块 SHALL 位于提示词首位，pack bot 的挂技能块（若有）紧随其后。

#### Scenario: 配置了人格
- **WHEN** bot 配置了 persona 且收到一条消息
- **THEN** 该回合提示词的首块 SHALL 为这段人格文本

#### Scenario: 未配置人格用中性默认
- **WHEN** bot 未配置 persona
- **THEN** 系统 SHALL 注入含该 bot 名的中性默认身份块，且该回合 SHALL NOT 以 cell 默认 preset 的角色口吻作答

#### Scenario: 与挂技能共存
- **WHEN** pack bot 同时有人格与挂载技能
- **THEN** 人格块 SHALL 在前、技能块 SHALL 在后，两者都在用户消息之前

#### Scenario: 内部运营口吻被抑制
- **WHEN** 用户在装有内部工具面的 cell 里询问该 bot「你能做什么」
- **THEN** 回复 SHALL 描述该 bot 自身的用途，SHALL NOT 描述内部决策队列、运营状态或舰队副驾职责

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
