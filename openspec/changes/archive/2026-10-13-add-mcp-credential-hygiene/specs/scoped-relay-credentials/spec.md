## Purpose

search-relay 的作用域令牌鉴权：平台交给各 cell 的搜索中继凭据不再是全平台单一静态值，而是按 cell/租户派生、可归因、可单独吊销的短面窄令牌，把凭据泄露的爆炸半径从"整个平台"缩到"单个 cell"。

## ADDED Requirements

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
