## MODIFIED Requirements

### Requirement: Search relay wiring is configurable from the settings surface

平台 SHALL 在 Settings → Connections 分节内提供管理员可用的「网络搜索」接线卡（search-service 卡），读写搜索 relay 的接线配置：relay 地址（`url`）与 relay 令牌（`token`）。旧 `/settings/websearch` 路由 SHALL 以重定向保语义（指向 `/settings/connections?panel=search`）。读取 SHALL NOT 回传令牌明文（只回 `hasToken` 与尾 4 位掩码）；写入空字符串 SHALL 清除该项、回退到部署环境变量。未配置存储值时，行为 SHALL 与本变更前逐字节一致（进程 env `SEARCH_RELAY_URL`/`SEARCH_RELAY_TOKEN` 兜底）。

#### Scenario: 读取当前配置（不回显令牌）

- **WHEN** 管理员打开 Settings → Connections 分节内的 search-service 卡
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

Settings → Connections 分节内的 search-service 卡 SHALL 提供连通性测试：以当前生效配置（含未保存的表单值）向 relay 发一次最小搜索请求，并返回可达性、鉴权结果与上游状态的可读结论。测试 SHALL NOT 持久化任何值。

#### Scenario: 可达且鉴权通过

- **WHEN** 测试请求到达一个接受该令牌的 relay
- **THEN** 结果 SHALL 报告成功（含 HTTP 状态），用户可据此确认接线正确

#### Scenario: 鉴权失败与不可达区分

- **WHEN** relay 返回 401/403，或连接超时/拒绝
- **THEN** 结果 SHALL 分别报告"令牌被拒"与"不可达"，且不把 5xx 上游状态误报为接线错误（503=鉴权通过但上游池干涸，应如实标注）

#### Scenario: 测试不落盘

- **WHEN** 用户在表单里改了值但未保存就点测试
- **THEN** 仅用表单值发请求，`deployment_config` SHALL 保持不变

### Requirement: Users can bring their own search key

Settings → Connections 分节内的 search-service 卡 SHALL 对所有登录用户可见。用户 SHALL 能保存自己的搜索提供商密钥（BYOK），语义为 write-only：读取面只回存在标记与尾 4 位掩码，永不回明文；保存 SHALL 立即生效（无需重启）；清除 SHALL 回退到共享池。用户密钥 SHALL 只影响该用户自己的搜索，且用户 SHALL 只能读写自己的密钥（身份取自请求，不接受客户端指定他人）。

#### Scenario: 保存后立即使用

- **WHEN** 用户保存自己的搜索密钥并随后发起一次搜索
- **THEN** 该搜索 SHALL 使用用户的密钥（响应来源标注为 user）

#### Scenario: 读取不回显

- **WHEN** 用户打开该卡或调用读取端点
- **THEN** 响应 SHALL 只含 `hasKey` 与尾 4 位掩码，SHALL NOT 含密钥明文

#### Scenario: 清除回退共享池

- **WHEN** 用户清除自己的密钥
- **THEN** 后续搜索 SHALL 使用共享池（来源标注为 pool）

### Requirement: Shared pool health is visible to administrators

Settings → Connections 分节内的 search-service 卡 SHALL 为管理员展示共享池健康。池的供给上游为平台网关
websearch 车道时，健康面 SHALL 以车道为主视图：上游模式（车道）、车道可达性、
车道侧错误计数与当日用量/上限；冷备直连路径已退役删除（retire-search-relay-direct），
SHALL 不再展示冷备启用计数与 per-key 冷却视图（该状态由词元管理面承担）。
数据经服务端以生效凭据代理 relay 只读统计端点，SHALL NOT 暴露任何 key、令牌
或车道凭据值。

#### Scenario: 管理员看到池状态

- **WHEN** 管理员打开 search-service 卡
- **THEN** SHALL 看到上游模式（车道）、车道可达性、错误计数、当日用量与上限

#### Scenario: 非管理员看不到管理区

- **WHEN** 非管理员用户打开 search-service 卡
- **THEN** SHALL 只看到自己的密钥区；共享服务配置与池状态 SHALL 不渲染，且相应端点 SHALL 对其返回 403

#### Scenario: keys 段隐藏

- **WHEN** 退役实施后打开 search-service 卡
- **THEN** 冷备 key 列表与冷却状态视图不再渲染，BYOK 配置区照常
