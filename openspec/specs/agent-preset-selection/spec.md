# agent-preset-selection Specification

## Purpose
User-facing selection of the dsh agent preset (composition mode) a new chat
session runs as. The server exposes the roster — the four shipped modes plus
user-authored presets, each with trust and broken marks — over the WebSocket,
applies a pick by restarting the dsh runtime with the preset in `initialize`
(next session only, never mid-session), persists it as a user preference, and
shows the running session's preset as read-only header chrome.

## Requirements

### Requirement: The chat surface offers the dsh agent preset roster

The server SHALL expose the dsh agent preset roster (the four shipped modes
`standard` / `code` / `minimal` / `cordis` plus any user presets discovered
under the dsh user preset root, and the pack-materialized local persona
presets) to the web client. Each roster entry SHALL carry a stable `id`, a
display `name`, a `description`, a `trust` mark (`system` or `user`), and a
`broken` flag with reason when the preset cannot compose a session. Rows the
roster marks `broken` SHALL be visible but not selectable.

The web app SHALL present the roster through the unified assistant selector
「与谁对话」 (openspec: agent-preset-selection, 统一的「与谁对话」选人面)
rather than a composition-mode-only picker. In that selector the shipped
composition modes other than `standard` (`code` / `minimal` / `cordis`) SHALL
be hidden by default — they are runtime-composition choices, not conversation
partners, and SHALL remain reachable to the user only through layout-level
opt-in (a resolved-layout predicate), never removed from the roster itself.
User-authored presets SHALL be listed with their distinct user mark.

#### Scenario: roster rendered on the welcome state

- **WHEN** an authenticated client opens the chat with no active turn and the
  runtime is ready
- **THEN** the unified assistant selector SHALL render listing the standard
  mode, user presets (marked), installed pack roles, and cluster group entries
- **AND** the shipped `code` / `minimal` / `cordis` modes SHALL NOT be listed
  unless a resolved-layout predicate opts them in
- **AND** the currently selected assistant SHALL be visually marked

#### Scenario: broken preset is shown but disabled

- **WHEN** the roster contains a preset whose composition is missing or
  unloadable
- **THEN** its row SHALL render with a failure indication and the reported
  reason and SHALL be disabled for selection

#### Scenario: deployment without a roster

- **WHEN** the runtime composes no agent-presets roster and no agent roster
- **THEN** the selector SHALL render nothing (no error, no blocking of chat)

### Requirement: Selecting a preset applies to the next session only

A preset choice is fixed when a session is created; dsh refuses to recompose a
session that has produced turns. The server SHALL apply a selected preset via
the bridge restart path (fresh dsh child `initialize` carrying the preset id),
SHALL reject `set_preset` while a turn is streaming (the same guard
`set_model` uses), and SHALL reject an unknown or broken preset id with an
`error` sent only to the requesting client. That streaming rejection is
enforced by the unified streaming guard inside `switchPresetTo` — the same
gate every preset switch passes through (server/ws.js:837-843 → agent-session
`switchPresetTo`) — rather than a separate `set_preset`-case check. The
selection SHALL be persisted as a user preference so a server restart keeps it.

#### Scenario: pick a mode from the welcome state
- **WHEN** the user selects a different preset in the picker while no turn is
  streaming
- **THEN** the server SHALL persist the choice, restart the dsh runtime with
  the preset in `initialize`, and broadcast `current_preset`
- **AND** the composer SHALL show the same pending-configuration block it
  shows for a model switch

#### Scenario: pick rejected while streaming
- **WHEN** a `set_preset` message arrives while the agent is responding
- **THEN** the server SHALL leave the current preset unchanged and answer an
  error

#### Scenario: existing sessions keep their preset
- **WHEN** the user opens a session created under another preset
- **THEN** that session SHALL keep the composition it started with; the picker
  is not offered mid-session

### Requirement: An active session shows its preset as a static label

Inside a non-blank session the header SHALL display the preset that session
runs as read-only chrome (`data-testid="agent-preset-label"`), never as a
live switch control. The label SHALL resolve the display name against the
roster and fall back to the preset id when the roster no longer supplies it.

#### Scenario: label reflects the running session
- **WHEN** a session is open
- **THEN** the header SHALL show that session's preset name (or the deployment
  default name when the session named none)
- **AND** interacting with the label SHALL NOT switch the running session's
  preset

### Requirement: WebSocket preset contract

The WebSocket protocol SHALL carry: server-to-client `presets`
(`{ presets, current }`) pushed on connect and after roster-invalidating
restarts, `current_preset` (`{ id }`) after a successful switch, and
client-to-server `list_presets` (roster fetch) and `set_preset` (`{ id }`).

#### Scenario: late-connecting client receives the roster
- **WHEN** a client connects after the runtime is ready
- **THEN** the connect-time sync SHALL include the current preset id and the
  client can obtain the full roster with `list_presets`

#### Scenario: preset-switch failure is visible
- **WHEN** the restart carrying the new preset fails
- **THEN** the server SHALL send an `error` to the requesting client and the
  previous preset SHALL remain reported as current

### Requirement: 统一的「与谁对话」选人面

壹座 SHALL 以**单一**选人控件承载会话的人格选择（「与谁对话」），取代此前
的双入口（欢迎态「模式」下拉 + 输入框 ⋯ 菜单「智能体」区）。该控件：

- **数据源**：以 agent roster 为主源（自带 `packId` / `customPreset` /
  `clusterId` 元数据与聚焦徽章），preset roster 仅贡献组合模式条目（经
  默认过滤后通常只剩「标准」）。同一功能集角色在两个 roster 中都有物化
  条目时 SHALL 只渲染一次（以 agent roster 条目为准，按 agent id 或
  packId 关联去重）。
- **呈现**：欢迎态与会话内渲染同一控件；条目按「标准助手 / 功能集角色
  （按功能集分组）/ 我的专家」分组；带集群元数据的功能集 SHALL 呈现
  「整组载入」条目——选中即按既有动态集群路径绑定会话
  （`POST /api/clusters/dynamic` `bindToSession`）并切到该集群的 lead
  角色，MUST NOT 在界面承诺多角色同时在线（运行时一次只承载一个人格）。
- **切换语义**：助手（人格）切换走既有 `set_agent` 契约（本地包角色 =
  preset 切换并重启 runtime，pending 语义与 `pendingConfig` 沿用；流式
  中拒绝）；组合模式（标准）切换沿用 `set_preset` 契约，且仅在会话未产
  生回合时可用（dsh 约束）。既有 `agent-preset-picker` 相关
  `data-testid` 契约 SHALL 由合并控件承接保留。

会话头部 SHALL 将运行中人格显示为只读标签（沿用现行 read-only chrome
契约），其文案与选人控件同名（「与谁对话」口径），MUST NOT 成为第二套
词汇。

#### Scenario: 同一功能集角色只出现一次

- **WHEN** 功能集「柏讯，投研三镜头」已安装，其角色在 preset roster 与
  agent roster 中均有物化条目
- **THEN** 选人控件中该角色只渲染一行，来自 agent roster，带聚焦徽章

#### Scenario: 会话中途换助手

- **WHEN** 用户在一个已有回合的会话中打开「与谁对话」并选择另一功能集角色
- **THEN** 客户端发送 `set_agent`，控件显示 pending，直到 `agent_changed`
  广播到达
- **AND** 运行时拒绝（流式中）时控件保持原值并显性报错

#### Scenario: 整组载入

- **WHEN** 用户在选人控件中选择带集群元数据的功能集的「整组载入」条目
- **THEN** 客户端按既有动态集群路径绑定会话并切换到 lead 角色
- **AND** 控件与头部显示 lead 角色名，不显示多角色同时在线的暗示

#### Scenario: 无可选人时不渲染

- **WHEN** 部署只有一个内置助手且无功能集、无自建专家
- **THEN** 选人控件 SHALL 不渲染（而非渲染一个不可改的单值控件）
