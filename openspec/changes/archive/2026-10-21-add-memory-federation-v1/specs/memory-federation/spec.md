## Purpose

记忆联邦：舰队记忆服务对壹座 cell 与本地 harness 节点开放——同一格式与协议下三类消费者（萬星部署 d/、壹座用户 u/、本地节点 u/ 经 /hook 直投）的接入契约。

## ADDED Requirements

### Requirement: /hook 兼容端点按上游实测协议接收投递

服务 SHALL 暴露 `POST /hook?event=<event>&agent=<agent>&cwd=<urlencoded>&ingest_key=<key>`：Bearer 人令牌鉴权；body 为 hook payload 原文（JSON）；事件落该令牌 owner 的 `u/<owner>/p/<cwd 的 basename>` namespace；agent/event 合法集合外的投递 MUST 结构化拒绝；同 `(ingest_key, session_id, event, ts)` 的重投 MUST 幂等（不双计）。

#### Scenario: 本地节点回合事件落库可检索

- **WHEN** 一台配置了 fleet profile 的本地 ai-memory 节点经 recover 排空投递一批 hook 事件
- **THEN** 事件落对应 u/ namespace，MCP query 面可检索到该会话的观测

#### Scenario: spool 重投不双计

- **WHEN** 同一 hook 事件因网络重试被投递两次
- **THEN** 仅计一次观测

### Requirement: platform 令牌是纯铸造面

fd-memory SHALL 支持 `platform` 族令牌：仅可调用铸造面为其用户代铸 person 令牌（绑定 `u/<user>`）；对 capture、/hook、MCP 数据面 MUST 全部拒绝。person 令牌经 /hook 与 MCP 写入自己的 u/ namespace，永不越界。

#### Scenario: platform 令牌碰数据面被拒

- **WHEN** platform 令牌调用 /hook、/capture 或 /mcp
- **THEN** 全部 403，无数据写入

#### Scenario: platform 代铸的 person 令牌全功能于自身 namespace

- **WHEN** platform 代铸 `u/alice` 的 person 令牌后，该令牌经 /hook 投事件、经 MCP 写 handoff
- **THEN** 两者都落 `u/alice` 名下且仅此 namespace

### Requirement: cell 记忆挂载遵守组合与凭据纪律

壹座 cell 的 dsh 组合 SHALL 注入 fd-memory MCP 行（工具名 `mcp__fd-memory__*`）：人令牌按 owner 由 cell 后端经 platform 令牌代铸并缓存，注入路径与既有 MCP 凭据引用纪律同源（值不落明文配置文件）；fd-memory 不可达时 cell 会话 MUST 降级开放（无记忆工具或工具报不可用，会话不因此失败）；挂载可经部署配置关闭。

#### Scenario: cell 会话见记忆工具并写入落库

- **WHEN** 一个壹座 cell 会话运行并调用 memory_handoff_begin
- **THEN** handoff 落 `u/<owner>/p/cell` namespace，舰队侧可检索

#### Scenario: 关闭开关回零

- **WHEN** 部署配置关闭 cell 记忆挂载
- **THEN** cell 组合输出与现状字节等同（无 MCP 行、无代铸调用）

### Requirement: 本地节点接入是纯配置动作

接入舰队 SHALL 只需上游原生配置（`server add` profile + 仓内 `.ai-memory.toml` + 定时 `ai-memory recover`），不要求修改上游代码或 fork；接入配方文档随服务仓发布。

#### Scenario: 新机器 30 分钟接入

- **WHEN** 一台装了 stock ai-memory 的机器按配方配置 profile 并运行 recover
- **THEN** 其后该机各仓的 hook 事件持续落舰队对应 namespace
