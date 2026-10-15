# web-search Specification

## Purpose

Gives the agent real-time web access through two first-party tools — `web_search` (served by the operator's key-pooling search relay) and `web_read` (local page fetch + text extraction) — available in every deployment form with zero customer configuration, degrading explicitly when the relay is unconfigured or unreachable.

## Requirements

### Requirement: Agent can search the web through a single normalized tool
The platform SHALL expose a `web_search` tool (callable name `mcp__websearch__web_search`) to every persona preset. It SHALL accept a natural-language query and an optional result-count limit, and SHALL return a normalized result list where each entry carries at least `title`, `url`, and `snippet`. The tool contract SHALL be identical regardless of which upstream engine the relay used, and the model SHALL NOT be asked to choose an engine.

#### Scenario: Query returns normalized results
- **WHEN** the agent calls `mcp__websearch__web_search` with a query
- **THEN** the tool SHALL return a list of results, each with `title`, `url`, and `snippet`
- **AND** the response SHALL NOT expose engine-specific envelopes or require engine knowledge to consume

#### Scenario: Upstream failover is invisible
- **WHEN** the relay serves the query from any upstream in its pool (e.g. a SerpAPI key or the GLM fallback)
- **THEN** the tool's input contract and normalized output shape SHALL be unchanged

### Requirement: Agent can read a web page locally
The platform SHALL expose a `web_read` tool (callable name `mcp__websearch__web_read`) that accepts an `http`/`https` URL, fetches it from the deployment's own network egress, and returns extracted readable text rather than raw HTML. The tool SHALL bound both fetch time and returned text size, and SHALL refuse non-`http(s)` schemes explicitly.

#### Scenario: URL returns readable text
- **WHEN** the agent calls `mcp__websearch__web_read` with an `https` URL
- **THEN** the tool SHALL return the page's extracted readable text
- **AND** the returned text SHALL NOT be the raw HTML source

#### Scenario: Non-http scheme is refused
- **WHEN** the agent calls the tool with a scheme other than `http`/`https`
- **THEN** the tool SHALL return an explicit error without performing a fetch

#### Scenario: Private-network targets are refused
- **WHEN** the agent calls the tool with a URL whose host is a private, loopback, or local-network address
- **THEN** the tool SHALL return an explicit error without performing the fetch

#### Scenario: Oversized page is truncated
- **WHEN** the fetched page's extracted text exceeds the configured size bound
- **THEN** the tool SHALL return truncated text and SHALL indicate truncation

#### Scenario: Unreachable page fails bounded
- **WHEN** the URL does not respond within the fetch timeout
- **THEN** the tool SHALL return an explicit timeout error
- **AND** the agent's turn SHALL continue (no hang, no crash)

### Requirement: Relay client contract keeps provider credentials operator-side
The platform SHALL talk to exactly one configurable search-relay endpoint (`SEARCH_RELAY_URL`) authenticated with a single relay token (`SEARCH_RELAY_TOKEN`) sent as a Bearer header. No upstream search-provider key (SerpAPI, GLM, or successor) SHALL appear in the repository, the bundle, any deployment's client-visible surface, or any environment variable of a customer deployment other than the relay pair.

#### Scenario: Only the relay pair is configured
- **WHEN** the deployment's environment is inspected
- **THEN** the only search-related credentials present SHALL be `SEARCH_RELAY_URL` and `SEARCH_RELAY_TOKEN`

#### Scenario: Request shape is stable
- **WHEN** the platform calls the relay
- **THEN** the call SHALL be `POST <SEARCH_RELAY_URL>/v1/search` with a JSON body containing the query and optional result-count limit, and an `Authorization: Bearer <SEARCH_RELAY_TOKEN>` header

### Requirement: Search degrades explicitly without breaking the turn
When the relay is unconfigured, unreachable, or returns an error, `web_search` SHALL return an explicit, agent-readable unavailability error within a bounded time, and the surrounding agent turn SHALL continue. `web_read` SHALL be unaffected by relay availability because it performs no relay calls.

#### Scenario: Unconfigured relay yields explicit error
- **WHEN** `SEARCH_RELAY_URL` or `SEARCH_RELAY_TOKEN` is not set and the agent calls `web_search`
- **THEN** the tool SHALL return an error stating that search is not configured, rather than attempting a network call
- **AND** `web_read` SHALL remain fully functional

#### Scenario: Relay outage fails bounded
- **WHEN** the relay is unreachable or returns a server error
- **THEN** `web_search` SHALL return an explicit error within the configured timeout
- **AND** no partial or malformed result list SHALL be returned as if it were valid

### Requirement: Search relay wiring is configurable from the settings surface

平台 SHALL 提供管理员可用的设置分区「网络搜索」，读写搜索 relay 的接线配置：relay 地址（`url`）与 relay 令牌（`token`）。读取 SHALL NOT 回传令牌明文（只回 `hasToken` 与尾 4 位掩码）；写入空字符串 SHALL 清除该项、回退到部署环境变量。未配置存储值时，行为 SHALL 与本变更前逐字节一致（进程 env `SEARCH_RELAY_URL`/`SEARCH_RELAY_TOKEN` 兜底）。

#### Scenario: 读取当前配置（不回显令牌）

- **WHEN** 管理员打开「网络搜索」分区
- **THEN** 端点 SHALL 返回生效中的 `url`、令牌的存在标记与掩码（`hasToken: true` + 尾 4 位）、以及来源（`stored` / `env` / 未配置）
- **AND** 响应任何字段 SHALL NOT 包含令牌明文

#### Scenario: 保存配置并热生效

- **WHEN** 管理员提交新的 url/token
- **THEN** 值 SHALL 落 `deployment_config`，且无需重启即触发 MCP patch 重写（cell 侧下一组合/热更新读取新值）

#### Scenario: 清除回退

- **WHEN** 管理员提交空 url 或空 token（清除）
- **THEN** 该项的存储值 SHALL 被删除，解析回退到部署环境变量；两者皆空时 `web_search` 的未配置降级文案 SHALL 照常生效

#### Scenario: 非管理员被拒

- **WHEN** 非管理员身份的请求打向配置读写端点
- **THEN** SHALL 返回 403（与既有 MCP 管理门一致；auth 关闭=机器属主，放行）

### Requirement: Search relay connectivity is testable from the settings surface

「网络搜索」分区 SHALL 提供连通性测试：以当前生效配置（含未保存的表单值）向 relay 发一次最小搜索请求，并返回可达性、鉴权结果与上游状态的可读结论。测试 SHALL NOT 持久化任何值。

#### Scenario: 可达且鉴权通过

- **WHEN** 测试请求到达一个接受该令牌的 relay
- **THEN** 结果 SHALL 报告成功（含 HTTP 状态），用户可据此确认接线正确

#### Scenario: 鉴权失败与不可达区分

- **WHEN** relay 返回 401/403，或连接超时/拒绝
- **THEN** 结果 SHALL 分别报告"令牌被拒"与"不可达"，且不把 5xx 上游状态误报为接线错误（503=鉴权通过但上游池干涸，应如实标注）

#### Scenario: 测试不落盘

- **WHEN** 用户在表单里改了值但未保存就点测试
- **THEN** 仅用表单值发请求，`deployment_config` SHALL 保持不变

### Requirement: Stored relay token remains cell-scoped when a scoped master is configured

当部署配置了 `SEARCH_RELAY_SCOPED_MASTER` 时，写入 cell patch 的 `SEARCH_RELAY_TOKEN` SHALL 继续按 cell 派生（沿用 add-mcp-credential-hygiene 的派生规则）；设置面存储的令牌值只作为无 scoped master 时的兜底，SHALL NOT 绕过作用域化把共享值注入 cell。

#### Scenario: scoped master 在场时存储值不直接进 patch

- **WHEN** cell 的 MCP patch 在 `SEARCH_RELAY_SCOPED_MASTER` 在场时被写出
- **THEN** patch 中的 `SEARCH_RELAY_TOKEN` SHALL 是 `wsrc-` 派生值，而非设置面存储的原始值或进程 env 的共享值

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

「网络搜索」分区 SHALL 为管理员展示共享池健康。池的供给上游为平台网关
websearch 车道时，健康面 SHALL 以车道为主视图：上游模式（车道/冷备直连）、
车道可达性、车道侧错误计数、冷备启用次数与当日用量/上限；迁移窗口内冷备
直连路径的 key 状态可一并展示，冷备退役后 SHALL 不再展示 per-key 冷却视图
（该状态由词元管理面承担）。数据经服务端以生效凭据代理 relay 只读统计端点，
SHALL NOT 暴露任何 key、令牌或车道凭据值。

#### Scenario: 管理员看到池状态

- **WHEN** 管理员打开分区
- **THEN** SHALL 看到上游模式（车道/冷备）、车道可达性、错误与冷备计数、当日用量与上限

#### Scenario: 非管理员看不到管理区

- **WHEN** 非管理员用户打开分区
- **THEN** SHALL 只看到自己的密钥区；共享服务配置与池状态 SHALL 不渲染，且相应端点 SHALL 对其返回 403

### Requirement: Search is off by default and enabled per session

websearch 工具 SHALL 默认不进入会话的有效工具面（部署可经 `PACK_BASELINE_MCP` 显式回到常开，但平台默认配置为关）。用户 SHALL 能经对话输入框的会话级联网开关（见 chat-composer-controls）为当前会话开启/关闭，开启 SHALL 经 `tools/set` 会话级工具闸免重启生效，SHALL 只影响该会话。运营商经扩展面整体停用 websearch 服务器的既有能力不变。

#### Scenario: 新会话默认无搜索工具

- **WHEN** 用户开启新会话且未翻转联网开关
- **THEN** 该会话的有效工具面 SHALL 不含 websearch 工具

#### Scenario: 会话内翻开开关后可搜索

- **WHEN** 用户翻开联网开关并发起会触发搜索的提问
- **THEN** 该会话 SHALL 可调用 websearch 工具
- **AND** 其他未开启会话 SHALL 不受影响

#### Scenario: 运营商整体停用仍优先

- **WHEN** 管理员经扩展面停用 websearch 服务器
- **THEN** 会话级开关 SHALL 不恢复其工具（会话闸只做收紧-放开，不越权启停服务器）



### Requirement: 共享搜索供给由平台网关车道承担

relay 的共享池 SHALL 经平台网关的 websearch 车道（词元）服务：relay 持一枚
内部专用车道凭据（自有分组、websearch 价目为零、用量入账），供应商 key
（SerpAPI 及后继）SHALL 只维护在词元账号池——relay 的 keys 集合 SHALL NOT
再作为常设供给源。迁移窗口内允许保留直连供应商路径作冷备（车道不可达或
持续 5xx 时启用），冷备启用 SHALL 在 relay 统计中如实标注路由；窗口结束后
直连路径与对应 keys SHALL 退役删除。调用者可见契约（请求/响应形状、鉴权、
来源三态标注）SHALL 全程不变。

#### Scenario: 共享池请求走车道

- **WHEN** 调用者不带用户 key 请求 relay 搜索且车道可达
- **THEN** 请求由词元 websearch 车道服务（relay 以内部凭据调用），返回形状与来源标注（pool）与切换前一致

#### Scenario: 车道不可达冷备接管

- **WHEN** 词元车道不可达或在窗口期内持续 5xx，直连冷备路径已配置
- **THEN** relay 经冷备路径完成请求，调用者收到正常结果（来源仍如实标注池），relay 统计记录本次走了冷备路由

#### Scenario: 供应商 key 不再常设 relay 侧

- **WHEN** 迁移窗口结束（冷备路径退役后）检查 relay 配置
- **THEN** relay 的 keys 集合中 SHALL 不存在供应商 key，供给唯一来源为车道内部凭据
