## Purpose

CRM 客服台 agent 桥：以钉版本的开源 mcp-chatwoot server 把自托管 Chatwoot 客服台（A 租户「寻数 FindData」）接进壹座 agent 运行时，配「草拟优先、发送走动作闸、失败如实分类」的客服接待技能——AI 接待不依赖 Chatwoot 付费能力，凭据全程 BYOK env 注入。

## ADDED Requirements

### Requirement: chatwoot MCP server 经钉版本开源 server 接入

壹座运行时 SHALL 以 stdio 方式接入 `@fazer-ai/mcp-chatwoot`（版本钉死，不改其源码），作为操作员基线服务器 `chatwoot` 供 cell 的 MCP 通道使用。连接凭据 SHALL 仅经部署环境变量注入（`CHATWOOT_BASE_URL` / `CHATWOOT_API_TOKEN`），MUST NOT 落库、进日志或进配置仓；未配置所需 env 的部署 MUST NOT 出现该服务器条目。agent 可见的 chatwoot 工具面 SHALL 为标准 Chatwoot 实例可用的子集：fork 专属工具（`kanban_*`、`scheduled_messages_*`，标准实例 404）MUST NOT 出现在工具面亦 MUST NOT 可调用；发送类工具（`messages_create`、`messages_delete`）MUST NOT 出现在 agent 工具面——发送只能经动作闸提议通道（见 action-gate 能力）。所连实例为 Account 1「寻数 FindData」（zh_CN），工具调用中的 `account_id` SHALL 由技能钉为 1。

#### Scenario: 配好 env 的部署上 agent 可用 chatwoot 读类工具

- **WHEN** 平台部署配置了 `CHATWOOT_BASE_URL` 与 `CHATWOOT_API_TOKEN` 后 agent 组合运行时
- **THEN** 工具面含 chatwoot 服务器的读/流程类工具（会话、消息、联系人、收件箱等标准子集），不含任何 `kanban_*` / `scheduled_messages_*` / `messages_create` / `messages_delete`

#### Scenario: 未配 env 的部署不出现该服务器

- **WHEN** 未配置 chatwoot env 的部署（如演示、serving）组合任一用户的 MCP patch
- **THEN** patch 中不存在 chatwoot 服务器条目，该部署用户工具面零变化

#### Scenario: 凭据不落库不进日志

- **WHEN** 检查仓库、扩展配置数据库与运行日志
- **THEN** chatwoot token 只存在于部署环境变量与其显式转发的子进程 env，任何表、文件、日志行均不含其明文

#### Scenario: 发送类工具直接调用被拒

- **WHEN** agent 尝试直接调用 `mcp__chatwoot__messages_create`
- **THEN** 调用被工具面拦下并给出可读原因（不在该服务器的可见面内），不触达 Chatwoot

### Requirement: 客服接待技能草拟优先发送走闸

平台 SHALL 内置 `crm-desk-reception` 技能（仓根技能目录，随镜像分发），定义客服接待工作流：读未处理会话 → 读会话消息与联系人 → 在壹座对话中生成回复草稿 → 人工确认后经 `propose_action` 提议发送（动作闸 `crm.message.send`，write 档行内确认）→ 发送后读回消息复核送达。技能 SHALL 钉 `account_id=1` 与收件箱口径（网站挂件 inbox），SHALL 提示 Chatwoot 列表接口分页。默认 MUST 只草不发：未经人工确认 MUST NOT 提议或执行任何发送。

#### Scenario: 技能可经斜杠命令调用

- **WHEN** 用户在壹座对话输入 `/skill:crm-desk-reception 处理未读会话`
- **THEN** 技能内容被展开进提示词，agent 按工作流先读会话与消息并产出草稿，未发生任何发送

#### Scenario: 人工确认后发送且收件箱可见

- **WHEN** agent 产出草稿、用户在确认卡上批准 `crm.message.send`
- **THEN** 动作闸执行路径把消息发到对应会话，收件箱界面可见该回复，agent 读回消息列表确认送达

#### Scenario: 未确认前不发送

- **WHEN** 用户对草稿未予确认（拒绝或沉默）
- **THEN** 不发生任何 `messages_create` 执行，收件箱该会话保持原状

### Requirement: 工具失败如实分类上报

客服接待技能 SHALL 要求 agent 对任何 chatwoot 工具调用失败原样上报并给出原因分类（凭据无效 / 网络不可达 / 上游错误 / 参数被拒），MUST NOT 以空列表冒充「无数据」、MUST NOT 静默成功、MUST NOT 假报发送成功或编造会话状态。工具故障 MUST NOT 影响收件箱既有会话（Chatwoot 侧数据不因 agent 侧故障丢失或改变）。

#### Scenario: token 失效输出凭据无效

- **WHEN** `CHATWOOT_API_TOKEN` 被改为无效值后运行接待工作流
- **THEN** agent 输出失败与「凭据无效」分类（如 401 透传），而非空会话列表或静默成功；收件箱既有会话原状可查

#### Scenario: BASE_URL 不可达输出网络不可达

- **WHEN** `CHATWOOT_BASE_URL` 被改为不可达地址后运行接待工作流
- **THEN** agent 输出失败与「网络不可达」分类（连接失败透传），收件箱既有会话原状可查

#### Scenario: 上游拒绝输出上游错误

- **WHEN** Chatwoot 返回 4xx 校验错误或 5xx
- **THEN** agent 输出失败与「参数被拒」或「上游错误」分类并附上游原文，不重试到假装成功

### Requirement: 守界——fork 专属与付费能力不接

本能力 SHALL 不接入 fazer fork 专属能力（Kanban、定时消息）与 Chatwoot 付费版功能（Captain 等）；技能稿引用的每个工具名 MUST 与 server 实际注册的标准子集逐一核对存在。用户询问企微/公众号进箱等不做项时，技能 SHALL 如实回答不支持。

#### Scenario: 技能稿工具名全部真实存在

- **WHEN** 核对技能稿引用的工具名与 chatwoot server 实际注册的标准子集
- **THEN** 每个被引用的名字都存在且可调用，无引用 fork 专属或发送类工具
