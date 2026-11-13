## MODIFIED Requirements

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
The server SHALL provide CRUD REST routes for bot configurations (type, name, per-platform credential fields, enabled, persona text, and the per-bot tool switch) with credentials stored server-side only and masked in all API responses, and the web app SHALL provide a bots management surface whose primary entry is the platform icon grid, from which the operator creates, edits, enables/disables, and deletes bots, copies each bot's webhook URL, and opens its onboarding QR panel. The surface SHALL render as the Settings 渠道接入 (`channels`) section at `/settings/channels` rather than as a sidebar-navigated page, and the legacy `/bots` route SHALL redirect to `/settings/channels` so existing links keep resolving. Configuration changes SHALL take effect without a server restart.

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

#### Scenario: bots management lives in Settings
- **WHEN** the user opens Settings and selects the 渠道接入 (channels) section
- **THEN** the bots management surface SHALL render inside the Settings modal
- **AND** navigating to `/bots` SHALL redirect to `/settings/channels`

## ADDED Requirements

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
