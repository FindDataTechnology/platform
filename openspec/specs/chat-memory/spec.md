# chat-memory Specification

## Purpose

壹座主聊天面（web UI 回合）的记忆注入与 note 写纪律：把 fd-memory 的 digest 读面以三档阶梯接入每回合发出的 prompt，并把「用户明示记住时写 note」钉进双面单一来源的纪律文本，使换会话/隔天的主聊天不再冷启动。

## Requirements

### Requirement: 主聊天每回合记忆注入

本地 web 主聊天回合发出前，系统 SHALL 以当前连接用户为 owner，从其 fd-memory 根的 `default` project 读取 digest 并拼入该回合发出的 prompt，复用与集群侧同构的三档阶梯（digest → 共享标题列表 → 原样），逐档降级 warn 一行，任何失败不得阻塞回合。

digest 调用超时 SHALL 与集群侧同源可配（`CELL_MEMORY_DIGEST_TIMEOUT_MS`），未配置时 MUST 使用与 fd-memory embed 预算上限相匹配的默认值；生效超时 MUST 大于 fd-memory 侧 embed 预算上限。原固定「5 秒超时」表述取消——它与 fd-memory 的 embed 等待预算（上限 8000ms）冲突。

#### Scenario: 正常注入

- **WHEN** cell 记忆四件套配置齐、`CELL_MEMORY_CHAT_DIGEST` 未设为 0，用户在 web 主聊天发送一条消息
- **THEN** 该回合发出的 prompt 尾部含 /digest 渲染块（handoffs + L2 + 最近 notes），且当该用户根 default project 存在先前写回的 note 时，最近 note 出现在块中

#### Scenario: 降级开放

- **WHEN** /digest 调用超时或返回非 2xx
- **THEN** 回合不失败，warn 一行，阶梯降落到共享标题列表或原样 prompt

#### Scenario: 慢 embed 走降级而非整块丢失

- **WHEN** fd-memory embed 耗时超过其内部预算而退回关键词档（带降级注记）
- **THEN** digest 仍返回 200 与可渲染块，回合 prompt 含该块及注记，不因 embed 慢而整块丢失

#### Scenario: chat 与集群共用同一预算纪律

- **WHEN** 部署侧设置 `CELL_MEMORY_DIGEST_TIMEOUT_MS`
- **THEN** chat 面与集群回合注入使用同一超时值，两者的三档降级行为一致

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

MEMORY_DISCIPLINE（SDK `@finddatatechnology/yongyi-client` 纪律文本单一来源）SHALL 含 note 触发纪律：用户明示记住某事、或 agent 学到跨会话有价值的偏好/事实时，调用 `memory_write_page` 记 note。该文本 SHALL 经既有双面（fleet runner persona / cell preset suffix）生效，且挂载关闭时输出字节等同。fd-memory note 工具描述 SHALL 携带同义触发提示。

note 写纪律的定位 SHALL 是 L1 观点层补充而非记忆成立的前提：web chat、社交 bot、智语房间的回合 L0 底座由平台担保捕获（`platform-turn-capture`）兑现，agent 未主动写 note 的回合仍 SHALL 有 L0 落底。纪律文本中「会话收尾调 memory_handoff_begin」条款保留（handoff 属 L1 观点层，平台 tap 不可替代其意图传达价值）。

#### Scenario: 纪律行双面生效

- **WHEN** cell 记忆开启时生成 preset patch，或 runner 在挂载存在时物化 persona
- **THEN** persona 文本含 note 触发行；`CELL_MEMORY_ENABLED=0` 时不含且其余输出字节等同

#### Scenario: agent 不写 note 仍有记忆底座

- **WHEN** 一个回合中 agent 未调用任何 memory 写工具（纪律未被遵循）
- **THEN** 平台捕获仍落一条回合 L0（`platform-turn-capture`），下一回合的 digest 注入含其过程叙事——记忆成立不依赖模型自觉

### Requirement: eval note 场景

continuation eval 场景集 SHALL 含不少于 3 个背景存于 note 的场景，且 digest 臂在含 note 场景的全集上维持既有门槛。

#### Scenario: note 场景通过

- **WHEN** 以含 note 场景的全场景集跑 digest 臂对 none/titles
- **THEN** 重推导度 avg diff ≥ 0.5 且 win/noninferior 率 ≥ 70%，结果记入 continue-baseline

### Requirement: facade/智语消费同一 digest 读缝

facade 与智语类对客聊天面（网站嵌入、客户房间）SHALL 复用与壹座主聊天同源的 digest 读缝：按会话归属的 owner 读取 digest 注入回合 prompt，同一三档降级与 warn 纪律，任何记忆读面失败不得阻塞回合；游客会话不得获得其 owner 记忆注入，登入住户按本人根生效；tier/tag 语义与 fd-memory digest 对齐（引用名份不拖正文）。

#### Scenario: 万星网站客服位的登入用户接到记忆

- **WHEN** 登入用户在 facade 页开始会话并发送消息
- **THEN** 其本人 owner 记忆以 digest 拼入 prompt，canonical reference 名份可入
- **AND** 该 user 退出后以游客身份接续时，prompt 不再含 owner 记忆

#### Scenario: 记忆读面超时

- **WHEN** digest 召唤超过时限
- **THEN** 回合按降级档照旧发出的 prompt，日志记 warn 一条
