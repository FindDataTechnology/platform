## ADDED Requirements

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
