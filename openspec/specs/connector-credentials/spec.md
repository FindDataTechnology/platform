# connector-credentials Specification

## Purpose
壹座侧的萬星 connector 凭据：用户把 connector 铸造的 PAT 粘贴进壹座后，它按用户存储、只写不读地暴露状态，并在每次有效 profile 写入时注入到 connector MCP 服务行的 Authorization 头，使 dsh 会话能以用户自己的身份使用 connector 里保存的 SaaS 连接。

## Requirements

### Requirement: Per-user connector credential storage

壹座 SHALL 按用户身份（hosted 模式为登录邮箱，auth off 为 machine-owner）存储一份 connector PAT，包含 token 与更新时间。存储 SHALL 复用与 registry 凭据相同的键控与退化规则，SHALL NOT 因用户未连接而创建占位行。

#### Scenario: 粘贴即连接

- **WHEN** 已登录用户提交一个非空 PAT
- **THEN** 该用户名下出现 connector 凭据行，状态投影报告已连接与更新时间
- **AND** 同一用户的后续读取返回已连接状态

#### Scenario: 各用户互不可见

- **WHEN** 用户 A 已连接而用户 B 未连接
- **THEN** B 的状态投影报告未连接，B 的任何请求都不会读到 A 的 token

#### Scenario: auth off 退化为机器所有者

- **WHEN** 部署未启用认证（桌面/开发）且用户提交 PAT
- **THEN** 凭据以 machine-owner 键存储，读取与注入使用同一键

### Requirement: Connector credential is write-only from the client

任何 HTTP 响应 SHALL NOT 包含 PAT 明文或其任何前缀片段；凭据端点只返回连接状态、更新时间与断开标记。日志与错误消息同样 SHALL NOT 回显 token。

#### Scenario: 状态响应不含 token

- **WHEN** 客户端读取 connector 凭据状态
- **THEN** 响应体只含 connected / updatedAt / stale 等投影字段，不含 token

#### Scenario: 错误路径不回显

- **WHEN** 提交的 PAT 被拒绝或存储失败
- **THEN** 错误响应与日志中都不出现所提交的 token 内容

### Requirement: Disconnect removes the credential

用户 SHALL 能断开 connector：断开后该用户的凭据行不再存在，状态投影回到未连接，且下一次 profile 写入不再注入 connector 头。

#### Scenario: 断开后状态归零

- **WHEN** 已连接用户请求断开
- **THEN** 凭据被删除，状态投影报告未连接

#### Scenario: 断开后服务消失

- **WHEN** 用户在已安装 connector MCP 服务的情况下断开凭据
- **THEN** 下一次有效 profile 写入省略该服务，其安装记录保留

### Requirement: Connector credential API is owner-scoped

凭据的读状态/写入/清除端点 SHALL 只作用于请求身份自己的凭据；hosted 模式下匿名请求 SHALL 被拒绝（401），未启用认证时 SHALL 落到 machine-owner。

#### Scenario: 匿名写入被拒

- **WHEN** hosted 模式下未认证请求尝试写入 connector 凭据
- **THEN** 返回 401 且不产生任何凭据行

#### Scenario: 认证用户只能改自己的

- **WHEN** 用户 A 提交写入或清除
- **THEN** 变更只落在 A 的名下，B 的凭据不受影响

### Requirement: Settings panel entry for the connector credential

设置面 SHALL 提供一个 connector 凭据卡片：可粘贴 PAT、显示已连接/未连接状态与更新时间、可断开，并在未连接时说明 PAT 从何处获取（connector 的「我的连接」页面）。

#### Scenario: 未连接时可粘贴

- **WHEN** 用户打开设置面且尚无 connector 凭据
- **THEN** 卡片显示未连接与获取 PAT 的指引，并提供粘贴入口

#### Scenario: 已连接时显示状态并可断开

- **WHEN** 用户已连接
- **THEN** 卡片显示已连接与更新时间，并提供断开操作

### Requirement: Paste-time validation rejects malformed or dead PATs

粘贴端点 SHALL 校验 PAT 形状与存活：非 `oct_` 前缀的提交 SHALL 被拒收（400，指明不是 connector PAT）；形状合法的 PAT SHALL 对 connector MCP 入口做一次探活（Authorization 头携带该 PAT），探活返回 401 时 SHALL 拒收（400，指明 token 已失效或错误），网络错误或服务端 5xx 时 SHALL 照常存储。探活目标 SHALL 取自部署基线中 connector 服务行的 url，不另行硬编码；基线无该行时 SHALL 跳过探活仅做形状校验。

#### Scenario: 非法前缀当场拒收

- **WHEN** 用户粘贴一个不以 `oct_` 开头的字符串
- **THEN** 返回 400 且指明不是 connector PAT，不产生凭据行

#### Scenario: 已撤销 PAT 当场拒收

- **WHEN** 用户粘贴一个形状合法但已被撤销的 PAT，且探活返回 401
- **THEN** 返回 400 且指明 token 已失效或错误，不产生凭据行

#### Scenario: connector 不可达不阻断录入

- **WHEN** 探活因网络错误或服务端 5xx 失败
- **THEN** PAT 照常存储，凭据行建立

### Requirement: Revoked PAT is surfaced and the server is dropped

当已存储 PAT 失效（用户在 connector 侧撤销）而会话中的 connector 工具调用返回 401 时，平台 SHALL 把该用户的 connector 凭据标记为失效（不删除行）、从有效 profile 省略 connector 服务并重新应用，且一轮连续 401 只触发一次重新应用。失效状态 SHALL 投影到凭据状态面并广播给已连接的客户端；用户重新粘贴有效 PAT 即恢复，无需重装服务。

#### Scenario: 401 翻面恰好一次重应用

- **WHEN** 已连接用户的 connector 工具调用连续返回 401
- **THEN** 凭据被标记失效，connector 服务从有效 profile 省略并重新应用一次（后续 401 不再重复触发）
- **AND** 状态投影报告已失效，客户端收到凭据失效广播

#### Scenario: 重粘即恢复

- **WHEN** 失效用户重新粘贴一个有效 PAT
- **THEN** 失效标记随存储清除，下一次 profile 写入重新注入 connector 服务，无需重装
