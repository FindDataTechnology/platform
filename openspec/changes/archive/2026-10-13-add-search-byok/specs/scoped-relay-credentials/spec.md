## ADDED Requirements

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
