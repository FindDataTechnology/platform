## ADDED Requirements

### Requirement: Users can bring their own search key

「网络搜索」设置分区 SHALL 对所有登录用户可见。用户 SHALL 能保存自己的搜索提供商密钥（BYOK），语义为 write-only：读取面只回存在标记与尾 4 位掩码，永不回明文；保存 SHALL 立即生效（无需重启）；清除 SHALL 回退到共享池。用户密钥 SHALL 只影响该用户自己的搜索，且用户 SHALL 只能读写自己的密钥（身份取自请求，不接受客户端指定他人）。

#### Scenario: 保存后立即使用

- **WHEN** 用户保存自己的搜索密钥并随后发起一次搜索
- **THEN** 该搜索 SHALL 使用用户的密钥（响应来源标注为 user）

#### Scenario: 读取不回显

- **WHEN** 用户打开分区或调用读取端点
- **THEN** 响应 SHALL 只含 `hasKey` 与尾 4 位掩码，SHALL NOT 含密钥明文

#### Scenario: 清除回退共享池

- **WHEN** 用户清除自己的密钥
- **THEN** 后续搜索 SHALL 使用共享池（来源标注为 pool）

### Requirement: Relay prefers the user key and falls back to the shared pool

搜索请求携带用户密钥时，relay SHALL 优先用该密钥执行；该密钥失败（配额/鉴权/限流）SHALL 自动回退共享池，并在响应来源中如实区分（`pool-after-user-failure`），SHALL NOT 静默吞掉回退。用户密钥与共享池全部失败时 SHALL 返回 503。用户密钥 SHALL NOT 出现在日志中（归因只用其哈希前缀）。

#### Scenario: 用户密钥优先

- **WHEN** 请求带有效用户密钥且该密钥可用
- **THEN** 结果来自该密钥，来源标注 user，共享池不被消耗

#### Scenario: 用户密钥失败自动回退

- **WHEN** 请求带用户密钥但该密钥失败，共享池有可用 key
- **THEN** 结果来自共享池，来源标注 pool-after-user-failure（面板与 agent 均可见）

#### Scenario: 双失败

- **WHEN** 用户密钥失败且共享池干涸
- **THEN** relay 返回 503，错误文案说明含用户密钥在内的全部来源均失败

#### Scenario: 密钥不落日志

- **WHEN** 用户密钥被用于任何请求（成功或失败）
- **THEN** relay 日志 SHALL NOT 包含密钥值，归因只出现哈希前缀

### Requirement: Search results and settings surface disclose which credential served the request

搜索响应 SHALL 携带来源标注（user / pool / pool-after-user-failure），web_search 工具结果 SHALL 将其透出；设置面板的连通性测试 SHALL 展示该来源，使用户能区分"正在用自己的密钥"与"已回退共享池"。

#### Scenario: 工具结果带来源

- **WHEN** agent 调用 web_search 且 relay 以某来源服务了该请求
- **THEN** 工具结果 SHALL 含该来源标注

#### Scenario: 面板测试显示来源

- **WHEN** 用户在面板点测试且连接成功
- **THEN** 结论 SHALL 指明用的是用户密钥还是共享池（含回退情形）

### Requirement: Shared pool health is visible to administrators

「网络搜索」分区 SHALL 为管理员展示共享池健康（key 数、各 key 冷却状态、池干涸计数、当日用量与上限），数据经服务端以生效凭据代理 relay 只读统计端点，SHALL NOT 暴露任何 key 或令牌值。

#### Scenario: 管理员看到池状态

- **WHEN** 管理员打开分区
- **THEN** SHALL 看到共享池的 key 计数、冷却标记与池干涸/上游错误计数

#### Scenario: 非管理员看不到管理区

- **WHEN** 非管理员用户打开分区
- **THEN** SHALL 只看到自己的密钥区；共享服务配置与池状态 SHALL 不渲染，且相应端点 SHALL 对其返回 403
