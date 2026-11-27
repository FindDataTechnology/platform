## Purpose

search-relay 的作用域令牌鉴权：平台交给各 cell 的搜索中继凭据不再是全平台单一静态值，而是按 cell/租户派生、可归因、可单独吊销的短面窄令牌，把凭据泄露的爆炸半径从"整个平台"缩到"单个 cell"。

## Requirements

### Requirement: Relay accepts scoped tokens derived from a master secret

search-relay 除静态 `tokens` 列表外，接受由 master secret 对 scope 标识做 HMAC 派生的令牌（`wsrc-<scope-id>-<hmac>` 形态）。派生无状态：relay 不需要预先登记每个 cell，校验只依赖 master secret。

#### Scenario: scoped token authenticates

- **WHEN** 携带合法派生令牌（scope-id 存在、HMAC 匹配、未被吊销）的请求到达 `/v1/search`
- **THEN** 该请求按与静态令牌完全相同的配额与缓存语义获得服务

#### Scenario: static tokens keep working during migration

- **WHEN** 携带静态 `tokens` 列表内令牌的请求到达
- **THEN** 校验通过（静态列表与派生令牌两通道长期并存，迁移不设截止期）

### Requirement: Scoped tokens are attributable

令牌明文自带 scope 归因（scope-id 是令牌明文组成部分），日志与用量计数按 scope 记账，不记录也不依赖完整令牌值。

#### Scenario: attribution in logs

- **WHEN** 一个派生令牌的请求被 401/429/503 拒绝或正常服务
- **THEN** 日志行含该令牌的 scope 标识前缀，凭泄露值即可定位受害面

### Requirement: A scope can be revoked without affecting others

吊销按 scope 生效（denylist），不影响静态令牌与其他 scope。被吊销 scope 的令牌立即失效。

#### Scenario: revoked scope rejected

- **WHEN** scope `cell-abc` 被加入 denylist 后，其派生令牌再次请求
- **THEN** 返回 401，且其他 scope 与静态令牌不受影响

### Requirement: Relay refuses to start with neither static tokens nor master secret

与既有"拒绝裸奔启动"约束一致：静态列表为空且未配置 master secret 时，relay 启动即失败退出，不得以无鉴权状态监听。

#### Scenario: no credential material configured

- **WHEN** keys.json 无 tokens 且环境未设派生 master secret
- **THEN** relay 打印明确错误并以非零码退出，不监听端口

### Requirement: Relay accepts a request-scoped upstream key override

search-relay SHALL 接受请求头 `X-Serpapi-Key` 作为请求级上游密钥覆盖：鉴权（静态/scoped relay 令牌）不变，覆盖密钥 SHALL 只影响该次请求的提供方选择，SHALL NOT 被 relay 持久化，SHALL NOT 绕过 relay 自身的鉴权与每日上限。覆盖密钥的失败冷却 SHALL 与共享池独立记录，且归因只用其哈希前缀。

#### Scenario: 无覆盖时行为不变

- **WHEN** 请求不带 `X-Serpapi-Key`
- **THEN** relay SHALL 完全按本变更前行为执行（共享池轮询、冷却、计数）

#### Scenario: 覆盖不绕过鉴权与上限

- **WHEN** 请求带覆盖密钥但 relay 令牌无效，或当日上限已达
- **THEN** SHALL 照常 401 / 429，覆盖密钥不改变鉴权与配额判定

#### Scenario: 覆盖密钥不落盘不落日志

- **WHEN** 覆盖密钥被用于请求
- **THEN** relay SHALL NOT 将密钥写入任何持久状态；日志中只出现其哈希前缀

### Requirement: Relay exposes the serving credential source

relay SHALL 在搜索响应中携带来源标注（`x-search-source`：`user` / `pool` / `pool-after-user-failure`），并在只读统计中提供覆盖密钥的使用计数（used/failed/fallback），计数 SHALL NOT 含密钥值。

#### Scenario: 来源头出现

- **WHEN** 任一来源服务了一次成功搜索
- **THEN** 响应头 `x-search-source` SHALL 标注该来源

#### Scenario: 统计含覆盖计数

- **WHEN** 覆盖密钥被使用或失败
- **THEN** `/v1/stats` SHALL 反映覆盖使用/失败/回退计数（仅计数）
