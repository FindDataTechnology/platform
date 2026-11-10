# paper-trading-credentials Specification

## Purpose

壹座侧的柏讯模拟交易凭据：每 identity 一枚粘贴式 `fdt_` 长命 token（不过期、可吊销
即时生效、无设备配对协议），存服务端并在每次有效 profile 写入时注入 paper-trading
MCP 服务行的 Authorization 头——使 dsh 会话能以用户自己的模拟盘身份操作柏讯模拟
交易服务（账户/持仓/订单/行情/策略，paper-only）。token 明文只存服务端，永不回传
浏览器。

## Requirements

### Requirement: Token is stored per user and never exposed

壹座 SHALL 按 identity（hosted=登录邮箱，auth off=machine-owner）存至多一枚
paper-trading token（单槽：token 即身份，服务无多账户维度）。任何 HTTP 响应、日志
或错误消息 SHALL NOT 包含 token 明文或其前缀片段；状态投影只含 connected、stale
与 updatedAt。DB 不可用 SHALL 退化为「未连接」而非报错炸面。

#### Scenario: 未粘贴即未连接

- WHEN 用户尚未粘贴 token 而查看状态
- THEN 投影报告未连接，且不存在任何注入发生

#### Scenario: token 不出库

- WHEN 任意 API 被调用或服务报错
- THEN 输出不含 token 材料

### Requirement: Connect pastes a token with an advisory liveness probe

`POST /api/paper-trading/connection` SHALL 接受 `fdt_` 前缀 token 并做一次服务侧
探活（GET `<服务 origin>/api/v1/accounts` 带 Bearer）：401 SHALL 硬拒（死 token 或
粘贴错误，不落任何本地行）；200 或任何其他结果（网络失败、5xx）SHALL 照存——服务
临时不可用不得阻断保存凭据。重复粘贴 SHALL 整体替换旧行并清除 stale。

#### Scenario: 有效 token 粘贴即连接

- WHEN 用户粘贴服务 Web 自铸的 `fdt_` token 且探活 200
- THEN 状态投影变为已连接，下一次有效 profile 写入注入该 token

#### Scenario: 死 token 被拒

- WHEN 探活应答 401（token 已吊销或粘贴残缺）
- THEN 粘贴被拒且本地无行，面板收到可读错误

#### Scenario: 服务宕机不阻断保存

- WHEN 探活网络超时或 5xx
- THEN token 照存为已连接（探活是 advisory，唯一硬判决是 401）

### Requirement: Tokens are injected on profile writes, per user

`liveToken(email)` SHALL 同步返回存储 token（长命、无过期、无续登）；stale 或无行
SHALL 返回 null。注入 SHALL 只发生在有效 profile 写入（credentialRef=paper-trading
的服务行加 `Authorization: Bearer <token>`）；无可用 token 时该服务行 SHALL 被省略
并留一条按 ref 聚合的告警。不同 identity 的 token SHALL 各入各的 profile——用户 A
与用户 B 在各自会话里看到的是各自的模拟盘账户。

#### Scenario: 省略而非裸连

- WHEN 用户未连接凭据而发生 profile 写入
- THEN paper-trading 服务行被省略（fail-closed），绝不无凭据外连

#### Scenario: 多用户隔离

- WHEN 用户 A 与用户 B 各自粘贴各自的 token 并在同一 cell 会话
- THEN A 的调用看到 A 的账户列表，B 的调用看到 B 的账户列表

### Requirement: 401 flips stale exactly once; recovery is a re-paste

服务判 401 时 `markInvalid(email)` SHALL 置 stale（状态翻转返回 true——恰一次重
应用，与 registry/connector/facet-market 同契约）并广播 `paper_trading_credential_
stale` WS 事件；该服务行随本次 profile 重写被省略。token 不过期，故 stale 的唯一
恢复路径 SHALL 是用户重新粘贴（有效重粘清除 stale）；不存在自动续登。

#### Scenario: 吊销即翻面

- WHEN 用户在服务 Web 吊销了注入中的 token，随后调用返回 401
- THEN 翻面恰一次，server 行从该用户 profile 消失，WS 事件到达面板

#### Scenario: 重粘即愈

- WHEN stale 状态下用户粘贴一枚新的有效 token
- THEN 连接态恢复，下一次 profile 写入重新注入新 token

#### Scenario: 邻居不受牵连

- WHEN 用户 A 的 token 被吊销翻面
- THEN 用户 B 的凭据与 profile 不受任何影响

### Requirement: Disconnect drops the local row

`DELETE /api/paper-trading/connection` SHALL 删除本地凭据行，此后 profile 写入省略
该服务行。token 的吊销是用户在服务 Web 侧的自助动作，壹座 SHALL NOT 因此阻断本地
删除。

#### Scenario: 断开即省略

- WHEN 用户断开且发生 profile 写入
- THEN paper-trading 服务行从有效 profile 省略

### Requirement: Pack installs honor the server's declared credential ref

registry 来源 MCP 的安装 SHALL 取 `entry.metadata.credential_ref ?? "registry"` 分派
连接门：`paper-trading` 条目要求 paper-trading 凭据已连接，未连接 SHALL 以
credential-required（409）拒装并指明连接入口；已连接 SHALL 装为
`credentialRef: "paper-trading"`。分派 SHALL NOT 把 paper-trading 条目错判为 registry
凭据已连接而放行（后者会产出装好即静默消失的死配置）。

#### Scenario: 未连接凭据拒装有指路

- WHEN 用户安装引用 fd-paper-trading 条目的 pack 而未粘贴 token
- THEN 安装被拒（credential-required，指明去连接柏讯模拟交易凭据），不产生死配置

#### Scenario: 已连接装为 paper-trading ref

- WHEN 用户已连接凭据并安装该 pack
- THEN 装出的 server 行带 credentialRef: "paper-trading"，对话内可用 19 工具
