# chat-memory delta

## MODIFIED Requirements

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
