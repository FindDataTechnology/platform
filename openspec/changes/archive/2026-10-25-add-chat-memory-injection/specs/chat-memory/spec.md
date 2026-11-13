# chat-memory Specification

## ADDED Requirements

### Requirement: 主聊天每回合记忆注入

本地 web 主聊天回合发出前，系统 SHALL 以当前连接用户为 owner，从其 fd-memory 根的 `default` project 读取 digest 并拼入该回合发出的 prompt，复用与集群侧同构的三档阶梯（digest → 共享标题列表 → 原样），逐档降级 warn 一行，任何失败不得阻塞回合。

#### Scenario: 正常注入

- **WHEN** cell 记忆四件套配置齐、`CELL_MEMORY_CHAT_DIGEST` 未设为 0，用户在 web 主聊天发送一条消息
- **THEN** 该回合发出的 prompt 尾部含 /digest 渲染块（handoffs + L2 + 最近 notes），且当该用户根 default project 存在先前写回的 note 时，最近 note 出现在块中

#### Scenario: 降级开放

- **WHEN** /digest 调用 5 秒超时或返回非 2xx
- **THEN** 回合不失败，warn 一行，阶梯降落到共享标题列表或原样 prompt

### Requirement: chat 面开关与零行为等同

`CELL_MEMORY_CHAT_DIGEST=0` 时 chat 注入 SHALL 完全不发起（零 HTTP 调用、发出的 prompt 字节等同无本变更）；cell 记忆未配置（四件套不齐）或无连接身份时 SHALL 同为 no-op。k/budget 与集群侧共用 `CELL_MEMORY_DIGEST_K` / `CELL_MEMORY_DIGEST_BUDGET`。

#### Scenario: 开关归零

- **WHEN** `CELL_MEMORY_CHAT_DIGEST=0` 且其余记忆配置齐
- **THEN** 发出的 prompt 与用户原文（含 @doc 展开）字节等同，fd-memory 零请求

### Requirement: 历史保真

chatHistory SHALL 只记用户 raw text；注入块不得写入历史行或 UI 回放。

#### Scenario: 历史行不含注入块

- **WHEN** 一条带记忆注入块的回合完成
- **THEN** chatHistory 该 user 行内容等于用户发送原文

### Requirement: note 写纪律单一来源

MEMORY_DISCIPLINE（memory-discipline.js 单一来源）SHALL 含 note 触发纪律：用户明示记住某事、或 agent 学到跨会话有价值的偏好/事实时，调用 `memory_write_page` 记 note。该文本 SHALL 经既有双面（fleet runner persona / cell preset suffix）生效，且挂载关闭时输出字节等同。fd-memory note 工具描述 SHALL 携带同义触发提示。

#### Scenario: 纪律行双面生效

- **WHEN** cell 记忆开启时生成 preset patch，或 runner 在挂载存在时物化 persona
- **THEN** persona 文本含 note 触发行；`CELL_MEMORY_ENABLED=0` 时不含且其余输出字节等同

### Requirement: eval note 场景

continuation eval 场景集 SHALL 含不少于 3 个背景存于 note 的场景，且 digest 臂在含 note 场景的全集上维持既有门槛。

#### Scenario: note 场景通过

- **WHEN** 以含 note 场景的全场景集跑 digest 臂对 none/titles
- **THEN** 重推导度 avg diff ≥ 0.5 且 win/noninferior 率 ≥ 70%，结果记入 continue-baseline
