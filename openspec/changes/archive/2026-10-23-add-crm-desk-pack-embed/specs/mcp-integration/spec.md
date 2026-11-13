## ADDED Requirements

### Requirement: stdio env 值解析自逐用户凭据

本地 stdio 服务器行 SHALL 可声明「env 名 → credentialRef」映射；MCP patch 组合时该 env 值 SHALL 从声明 ref 的**该用户**凭据解析（与 HTTP 条目 Authorization 头同一解析口径），MUST NOT 使用部署 env 或他人凭据。该用户无此 ref 的活凭据时，该条目对该用户 SHALL 整体省略（不写 patch、不拉子进程），省略为静默正常态；机器 owner（无认证身份）SHALL 维持既有部署 env 语义（组合结果与该能力引入前逐字节一致），MUST NOT 因引入本机制而改变。上游 401 SHALL 使该用户此凭据失效（与既有 ref 失效语义一致）。

#### Scenario: 凭据按用户隔离解析

- **WHEN** 两个用户各自连接了不同的 Chatwoot token 并各自组合运行时
- **THEN** 各自 cell patch 的 chatwoot env 只携带自己的 token，互不可见

#### Scenario: 无凭据的用户零污染

- **WHEN** 未连接 chatwoot 的用户组合运行时
- **THEN** patch 无 chatwoot 条目、无子进程拉起、无警告刷屏

#### Scenario: 失效凭据置 stale

- **WHEN** 某用户的 token 被 Chatwoot 吊销后其 cell 调用 chatwoot 工具收到 401
- **THEN** 该用户此凭据置 stale，浏览器下次访问收到重连接指引