## ADDED Requirements

### Requirement: MemberView 对 bot 类岗位附只读 bot 摘要

MemberView SHALL 在 `target.kind === "bot"` 的岗位附带只读 `bot` 摘要子对象：`{ enabled, lastInboundAt, lastOutboundAt, lastError }`。摘要 SHALL 从 bot 通道存储做 best-effort 映射：列缺 → null，`enabled` 反映 bot 配置开关（false ≠ 红）。该字段 SHALL NOT 引入新 bot 采集机制，亦 SHALL NOT 触发 bot 写操作。

#### Scenario: bot 类岗位带摘要

- **WHEN** cockpit 聚合返回一个 target.kind=bot 的岗位，其所绑 bot 已上线并最近收到一条入站消息
- **THEN** MemberView.bot.enabled=true，lastInboundAt 为该消息时刻，画布对节点呈现 bot 原生图标 + presence 状态点

#### Scenario: bot 通道未配置

- **WHEN** bot 通道从未启用或从未收到任何消息
- **THEN** MemberView.bot.lastInboundAt 为 null，节点图标设灰阶，不渲染状态红点

### Requirement: 画布与检查器以 bot 原生形态呈现 bot 类岗位

fleet 画布与 post 检查器 SHALL 将 `target.kind === "bot"` 的岗位显示为 bot 原生图标（与 BotsPage 单源 BotPlatformIcons），并附通道专属状态点（presence 聚合态）。其余 kind（persona/cluster/a2a/tool/cron/event）图标语义 SHALL NOT 因本 change 改变。

#### Scenario: bot 节点图标原生

- **WHEN** 舰队含 bot 类岗位与 persona 类岗位
- **THEN** bot 节点与 persona 节点分别用 BotPlatformIcon 与既有 NODE_COLORS.persona 渲染，可一眼区分

#### Scenario: 检查器 top 卡呈现 bot 摘要

- **WHEN** 用户打开一个 bot 类岗位的检查器
- **THEN** config tab 顶部呈现 bot 摘要行（enabled、最近入站时刻、最近错误若有），且点击直达 BotsPage 对应 bot 卡
